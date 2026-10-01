import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { unsafeDecode } from "lacewing";
import { signAccessToken, verifyAccessToken } from "../../../auth/jwt";
import { hashRefreshToken } from "../../../auth/tokens";
import type { Database } from "../../../db";
import { refreshTokens, type UserRole, users } from "../../../db/schema";
import { ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE } from "../../../http/cookies";
import { accessTokenFor, seedUser } from "../../../test/auth";
import { callerAs, callerWithHeaders } from "../../../test/context";
import { createTestDatabase } from "../../../test/db";

function cookiesFrom(headers: Headers): Record<string, string> {
	return Object.fromEntries(
		headers
			.getSetCookie()
			.map((cookie) => cookie.split(";")[0]?.split("=") ?? [])
			.map(([name, value]) => [name ?? "", value ?? ""]),
	);
}

const ALICE = { email: "alice@example.com", name: "Alice", password: "password123" };

describe("auth", () => {
	let db: Database;

	beforeEach(async () => {
		db = await createTestDatabase();
	});

	it("registers a user, sets httpOnly cookies, and never returns the hash", async () => {
		const { trpc, resHeaders } = callerWithHeaders(db);

		const user = await trpc.auth.register({ ...ALICE, email: "Alice@Example.com" });

		// Email is normalised, so Alice@ and alice@ are the same account.
		expect(user.email).toBe("alice@example.com");
		expect(user.role).toBe("user");
		expect(user).not.toHaveProperty("passwordHash");

		const setCookies = resHeaders.getSetCookie();
		expect(setCookies.some((c) => c.startsWith(`${ACCESS_COOKIE}=`))).toBe(true);
		expect(setCookies.some((c) => c.startsWith(`${REFRESH_COOKIE}=`))).toBe(true);

		// Script cannot read the token cookies; the CSRF cookie alone must be readable.
		const tokenCookies = setCookies.filter((c) => !c.startsWith(`${CSRF_COOKIE}=`));
		const csrfCookie = setCookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`));
		expect(tokenCookies.every((c) => c.includes("HttpOnly"))).toBe(true);
		expect(tokenCookies.every((c) => c.includes("Secure"))).toBe(true);
		expect(csrfCookie).toBeDefined();
		expect(csrfCookie).not.toContain("HttpOnly");

		// The tokens are in the cookies, not in the response body.
		expect(user).not.toHaveProperty("accessToken");
	});

	it("issues an access token that carries the user's id and role", async () => {
		const { trpc, resHeaders } = callerWithHeaders(db);

		const user = await trpc.auth.register(ALICE);

		const token = cookiesFrom(resHeaders)[ACCESS_COOKIE];
		const payload = await verifyAccessToken(db, token ?? "");

		expect(payload).toMatchObject({ sub: user.id, email: "alice@example.com", role: "user" });
	});

	it("refuses a correctly signed token whose role this app does not have", async () => {
		// The signature is ours, so only the claim check can catch it. A role outside the
		// enum would otherwise reach canMutate and requireAdmin typed as a UserRole.
		// On a live session, so the revocation check passes and only the role is wrong.
		const alice = await seedUser(db);
		const token = await accessTokenFor(db, alice, { role: "superuser" as UserRole });

		await expect(verifyAccessToken(db, token)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("mints RFC 9068 access tokens: typ at+jwt, pinned iss/aud, unique jti", async () => {
		const { trpc, resHeaders } = callerWithHeaders(db);

		await trpc.auth.register(ALICE);

		// unsafeDecode parses without verifying and returns an UntrustedJwt the type
		// system refuses wherever a VerifiedJwt is required. Verification rejects a token
		// missing any of these claims.
		const token = cookiesFrom(resHeaders)[ACCESS_COOKIE];
		const decoded = unsafeDecode(token ?? "");

		expect(decoded.header.typ).toBe("at+jwt");
		expect(decoded.payload.iss).toBe("http://localhost:3000");
		expect(decoded.payload.aud).toBe("http://localhost:3000/trpc");
		expect(decoded.payload.jti).toEqual(expect.any(String));
	});

	it("cannot be tricked into registering an admin", async () => {
		const { trpc } = callerWithHeaders(db);

		// The extra field is not in the schema, so it never reaches the insert.
		const user = await trpc.auth.register({
			...ALICE,
			email: "sneaky@example.com",
			role: "admin",
		} as never);

		expect(user.role).toBe("user");
	});

	it("refuses a duplicate email", async () => {
		const { trpc } = callerWithHeaders(db);

		await trpc.auth.register(ALICE);

		await expect(trpc.auth.register(ALICE)).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("refuses a duplicate even when two registrations race", async () => {
		const { trpc } = callerWithHeaders(db);

		// The UNIQUE index decides; the loser is a CONFLICT, not a 500.
		const results = await Promise.allSettled([
			trpc.auth.register(ALICE),
			trpc.auth.register(ALICE),
			trpc.auth.register(ALICE),
		]);

		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");

		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(2);

		for (const failure of rejected) {
			expect(failure.reason).toMatchObject({ code: "CONFLICT" });
		}
	});

	it("gives the same error for a wrong password and an unknown email", async () => {
		const { trpc } = callerWithHeaders(db);

		await trpc.auth.register(ALICE);

		// Identical, so login cannot be used to discover which emails have accounts.
		// (Each call is asserted where it is made: holding a rejected promise around for
		// later reads to the runner as an unhandled rejection.)
		await expect(
			trpc.auth.login({ email: "alice@example.com", password: "nope12345" }),
		).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			message: "Invalid email or password",
		});

		await expect(
			trpc.auth.login({ email: "ghost@example.com", password: "password123" }),
		).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			message: "Invalid email or password",
		});
	});

	it("logs in with the right password", async () => {
		const { trpc } = callerWithHeaders(db);

		await trpc.auth.register(ALICE);

		await expect(
			trpc.auth.login({ email: "alice@example.com", password: "password123" }),
		).resolves.toMatchObject({ email: "alice@example.com" });
	});

	it("rotates the refresh token, and the old one stops working", async () => {
		const registration = callerWithHeaders(db);
		await registration.trpc.auth.register(ALICE);

		const firstToken = cookiesFrom(registration.resHeaders)[REFRESH_COOKIE];
		expect(firstToken).toBeTruthy();

		const first = callerWithHeaders(db, { refreshToken: firstToken });
		await first.trpc.auth.refresh();

		const secondToken = cookiesFrom(first.resHeaders)[REFRESH_COOKIE];
		expect(secondToken).toBeTruthy();
		expect(secondToken).not.toBe(firstToken);

		// Replaying the old token - what a thief would have - is dead on arrival.
		const replay = callerWithHeaders(db, { refreshToken: firstToken });
		await expect(replay.trpc.auth.refresh()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		// The new one still works.
		const third = callerWithHeaders(db, { refreshToken: secondToken });
		await expect(third.trpc.auth.refresh()).resolves.toMatchObject({
			email: "alice@example.com",
		});
	});

	it("refuses an expired refresh token that was never revoked", async () => {
		const registration = callerWithHeaders(db);
		await registration.trpc.auth.register(ALICE);

		const token = cookiesFrom(registration.resHeaders)[REFRESH_COOKIE] ?? "";

		await db
			.update(refreshTokens)
			.set({ expiresAt: new Date(Date.now() - 1_000) })
			.where(eq(refreshTokens.tokenHash, hashRefreshToken(token)));

		const late = callerWithHeaders(db, { refreshToken: token });
		await expect(late.trpc.auth.refresh()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(late.resHeaders.getSetCookie()).toEqual([]);
	});

	it("revokes the refresh token on logout and clears the cookies", async () => {
		const registration = callerWithHeaders(db);
		await registration.trpc.auth.register(ALICE);

		const token = cookiesFrom(registration.resHeaders)[REFRESH_COOKIE];

		const session = callerWithHeaders(db, { refreshToken: token });
		await session.trpc.auth.logout();

		// Cookies are expired, not merely forgotten by the client.
		const cleared = session.resHeaders.getSetCookie();
		expect(cleared.every((c) => c.includes("Max-Age=0"))).toBe(true);

		const stored = await db.query.refreshTokens.findFirst();
		expect(stored?.revokedAt).toBeInstanceOf(Date);

		await expect(
			callerWithHeaders(db, { refreshToken: token }).trpc.auth.refresh(),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	describe("access tokens end with their session", () => {
		async function signIn() {
			const registration = callerWithHeaders(db);
			const user = await registration.trpc.auth.register(ALICE);
			const cookies = cookiesFrom(registration.resHeaders);

			return {
				user,
				accessToken: cookies[ACCESS_COOKIE] ?? "",
				refreshToken: cookies[REFRESH_COOKIE] ?? "",
			};
		}

		it("on logout, before the token expires", async () => {
			const { accessToken, refreshToken } = await signIn();
			await expect(verifyAccessToken(db, accessToken)).resolves.toBeTruthy();

			await callerWithHeaders(db, { refreshToken }).trpc.auth.logout();

			await expect(verifyAccessToken(db, accessToken)).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		});

		it("but not on rotation: the session goes on, and so do its tokens", async () => {
			const { accessToken, refreshToken } = await signIn();

			const rotated = callerWithHeaders(db, { refreshToken });
			await rotated.trpc.auth.refresh();
			const next = cookiesFrom(rotated.resHeaders);

			await expect(verifyAccessToken(db, accessToken)).resolves.toBeTruthy();
			await expect(verifyAccessToken(db, next[ACCESS_COOKIE] ?? "")).resolves.toBeTruthy();

			// Logging out with the rotated refresh token ends both.
			await callerWithHeaders(db, { refreshToken: next[REFRESH_COOKIE] }).trpc.auth.logout();

			await expect(verifyAccessToken(db, accessToken)).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
			await expect(verifyAccessToken(db, next[ACCESS_COOKIE] ?? "")).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		});

		it("when the session's refresh token expires", async () => {
			const { accessToken } = await signIn();

			await db.update(refreshTokens).set({ expiresAt: new Date(Date.now() - 1_000) });

			await expect(verifyAccessToken(db, accessToken)).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		});

		it("when an admin changes the user's role", async () => {
			const { user, accessToken } = await signIn();
			const admin = await seedUser(db, { email: "root@example.com", role: "admin" });

			await callerAs(db, {
				id: admin.id,
				email: admin.email,
				role: admin.role,
			}).user.setRole({ userId: user.id, role: "admin" });

			// The token still says "user": it must not outlive the change.
			await expect(verifyAccessToken(db, accessToken)).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		});

		it("and only their own: one device signing out leaves the other signed in", async () => {
			const { accessToken: phone } = await signIn();
			const laptop = callerWithHeaders(db);
			await laptop.trpc.auth.login({ email: ALICE.email, password: ALICE.password });
			const laptopCookies = cookiesFrom(laptop.resHeaders);

			await callerWithHeaders(db, {
				refreshToken: laptopCookies[REFRESH_COOKIE],
			}).trpc.auth.logout();

			await expect(verifyAccessToken(db, phone)).resolves.toBeTruthy();
			await expect(
				verifyAccessToken(db, laptopCookies[ACCESS_COOKIE] ?? ""),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		});

		it("refuses a signed token naming a session that does not exist", async () => {
			const { user } = await signIn();
			const token = await signAccessToken({
				sub: user.id,
				email: user.email,
				role: user.role,
				sid: "00000000-0000-4000-8000-000000000000",
			});

			await expect(verifyAccessToken(db, token)).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		});

		it("refuses another user's session id", async () => {
			const { user } = await signIn();
			const [own] = await db.select().from(refreshTokens);
			const [mallory] = await db
				.insert(users)
				.values({
					email: "m@example.com",
					emailKey: "m@example.com",
					name: "M",
					passwordHash: "x",
				})
				.returning();

			const token = await signAccessToken({
				sub: mallory?.id ?? "",
				email: "m@example.com",
				role: "user",
				sid: own?.sessionId ?? "",
			});

			expect(own?.userId).toBe(user.id);
			await expect(verifyAccessToken(db, token)).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		});
	});

	it("rejects auth.me without a session", async () => {
		await expect(callerWithHeaders(db).trpc.auth.me()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});
});
