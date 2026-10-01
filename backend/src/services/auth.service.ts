import { randomUUID } from "node:crypto";
import { type } from "arktype";
import { and, eq, gt, isNull } from "drizzle-orm";
import { requireActor } from "../auth/actor";
import { emailKey } from "../auth/email";
import { signAccessToken } from "../auth/jwt";
import { hashPassword, verifyPassword } from "../auth/password";
import { revokeSession } from "../auth/sessions";
import { generateRefreshToken, hashRefreshToken, refreshTokenExpiresAt } from "../auth/tokens";
import type { Database } from "../db";
import { type PublicUser, refreshTokens, toPublicUser, users } from "../db/schema";
import { AppError, isUniqueViolation, parseInput } from "../lib/errors";
import type { ServiceCtx } from "./context";

export const RegisterInput = type({
	email: "string.email",
	name: "1 <= string <= 100",
	// argon2 has no ceiling; this stops someone posting a megabyte for us to hash.
	// (bcrypt would have forced 72.)
	password: "8 <= string <= 128",
});

export const LoginInput = type({
	email: "string.email",
	password: "1 <= string <= 128",
});

export interface Session {
	user: PublicUser;
	accessToken: string;
	/** Opaque. The HTTP layer puts this in an httpOnly cookie; gRPC hands it back raw. */
	refreshToken: string;
}

/**
 * Takes anything that can insert, the database or a transaction, so `refresh` can revoke
 * the old token and mint the new one atomically. A new sign-in starts a session; `refresh`
 * passes the one it continues, which keeps that session's access tokens valid.
 */
async function issueSession(
	tx: Pick<Database, "insert">,
	user: PublicUser,
	sessionId: string = randomUUID(),
): Promise<Session> {
	const refreshToken = generateRefreshToken();

	await tx.insert(refreshTokens).values({
		userId: user.id,
		sessionId,
		tokenHash: hashRefreshToken(refreshToken),
		expiresAt: refreshTokenExpiresAt(),
	});

	const accessToken = await signAccessToken({
		sub: user.id,
		email: user.email,
		role: user.role,
		sid: sessionId,
	});

	return { user, accessToken, refreshToken };
}

export async function register(ctx: ServiceCtx, input: unknown): Promise<Session> {
	const { email, name, password } = parseInput(RegisterInput, input);

	const normalisedEmail = email.toLowerCase();

	try {
		const [user] = await ctx.db
			.insert(users)
			.values({
				email: normalisedEmail,
				emailKey: emailKey(email),
				name,
				passwordHash: await hashPassword(password),
				// Never from input, or anyone could register as an admin. Promotion is
				// the admin-only user.setRole.
				role: "user",
			})
			.returning();

		if (!user) {
			throw new AppError("INTERNAL", "Insert returned no row");
		}

		ctx.log.info({ event: "auth.register", userId: user.id }, "user registered");

		return await issueSession(ctx.db, toPublicUser(user));
	} catch (error) {
		// The key is the canonical mailbox, so an alias of a taken address lands here too.
		if (isUniqueViolation(error)) {
			ctx.log.info({ event: "auth.register.duplicate" }, "registration rejected");

			throw new AppError("CONFLICT", "That email is already registered");
		}

		throw error;
	}
}

export async function login(ctx: ServiceCtx, input: unknown): Promise<Session> {
	const { email, password } = parseInput(LoginInput, input);

	const user = await ctx.db.query.users.findFirst({
		// By canonical mailbox, so any alias the provider would deliver to signs in.
		where: eq(users.emailKey, emailKey(email)),
	});

	// One message for "no such user" and "wrong password", on purpose: a different answer
	// for each would let anyone test which emails have accounts.
	const invalid = new AppError("UNAUTHORIZED", "Invalid email or password");

	if (!user) {
		// Spend the time a real comparison costs, so the response time does not answer the
		// question the error message refuses to.
		await hashPassword(password);

		ctx.log.info({ event: "auth.login.failed", reason: "unknown_email" }, "login rejected");

		throw invalid;
	}

	if (!(await verifyPassword(password, user.passwordHash))) {
		ctx.log.info(
			{ event: "auth.login.failed", reason: "bad_password", userId: user.id },
			"login rejected",
		);

		throw invalid;
	}

	ctx.log.info({ event: "auth.login", userId: user.id, role: user.role }, "login ok");

	return issueSession(ctx.db, toPublicUser(user));
}

/**
 * Rotates the token: the old one is revoked in the same transaction, so a crash cannot
 * strand the user with a dead token or leave the old one alive. A stolen token is good
 * for one use; whoever refreshes second is rejected, which is the signal reuse detection
 * would build on.
 *
 * An argument, not input: it comes from a cookie over HTTP and the body over gRPC.
 */
export async function refresh(ctx: ServiceCtx, token: string | undefined): Promise<Session> {
	if (!token) {
		throw new AppError("UNAUTHORIZED", "No refresh token");
	}

	const tokenHash = hashRefreshToken(token);

	return ctx.db.transaction(async (tx) => {
		const now = new Date();

		// One conditional UPDATE: with a SELECT first, two concurrent refreshes of the same
		// token both read it as live and both get a session. Here the second WHERE no
		// longer matches.
		const [stored] = await tx
			.update(refreshTokens)
			.set({ revokedAt: now })
			.where(
				and(
					eq(refreshTokens.tokenHash, tokenHash),
					isNull(refreshTokens.revokedAt),
					gt(refreshTokens.expiresAt, now),
				),
			)
			.returning();

		if (!stored) {
			ctx.log.info({ event: "auth.refresh.rejected" }, "refresh rejected");

			throw new AppError("UNAUTHORIZED", "Invalid or expired refresh token");
		}

		const user = await tx.query.users.findFirst({ where: eq(users.id, stored.userId) });

		if (!user) {
			throw new AppError("UNAUTHORIZED", "Invalid or expired refresh token");
		}

		ctx.log.info({ event: "auth.refresh", userId: user.id }, "session refreshed");

		return issueSession(tx, toPublicUser(user), stored.sessionId);
	});
}

export async function logout(ctx: ServiceCtx, token: string | undefined): Promise<{ ok: true }> {
	if (token) {
		await revokeSession(ctx.db, hashRefreshToken(token));

		ctx.log.info({ event: "auth.logout" }, "logged out");
	}

	return { ok: true };
}

export async function me(ctx: ServiceCtx): Promise<PublicUser> {
	const current = requireActor(ctx.actor);

	const user = await ctx.db.query.users.findFirst({ where: eq(users.id, current.id) });

	if (!user) {
		// The token is signed and unexpired, but the account is gone.
		throw new AppError("UNAUTHORIZED", "Account no longer exists");
	}

	return toPublicUser(user);
}
