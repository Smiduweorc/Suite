import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { Database } from "../../../db";
import { type PublicUser, users } from "../../../db/schema";
import { encodeCursor } from "../../../services/page";
import { actorFor, seedUser } from "../../../test/auth";
import { callerAs } from "../../../test/context";
import { createTestDatabase } from "../../../test/db";

describe("admin-only user router", () => {
	let db: Database;
	let member: PublicUser;
	let admin: PublicUser;

	beforeEach(async () => {
		db = await createTestDatabase();

		member = await seedUser(db, { email: "bob@example.com", name: "Bob" });
		admin = await seedUser(db, { email: "root@example.com", name: "Root", role: "admin" });
	});

	it("is UNAUTHORIZED for anonymous callers", async () => {
		await expect(callerAs(db, null).user.list({})).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});

	it("is FORBIDDEN for signed-in non-admins", async () => {
		const bob = callerAs(db, actorFor(member));

		await expect(bob.user.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(bob.user.setRole({ userId: member.id, role: "admin" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(bob.user.delete({ userId: admin.id })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("cannot be escalated by a user promoting themselves", async () => {
		await expect(
			callerAs(db, actorFor(member)).user.setRole({ userId: member.id, role: "admin" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		// And the database did not budge.
		const bob = await db.query.users.findFirst();
		expect(bob?.role).not.toBe("admin");
	});

	it("lets an admin list users, without password hashes", async () => {
		const { items: users } = await callerAs(db, actorFor(admin)).user.list({});

		expect(users).toHaveLength(2);
		expect(users.every((user) => !("passwordHash" in user))).toBe(true);
	});

	it("lets an admin promote someone", async () => {
		const promoted = await callerAs(db, actorFor(admin)).user.setRole({
			userId: member.id,
			role: "admin",
		});

		expect(promoted.role).toBe("admin");

		// And now Bob really can act as one.
		await expect(callerAs(db, actorFor(promoted)).user.list({})).resolves.toMatchObject({
			items: { length: 2 },
		});
	});

	it("stops the last admin from locking everyone out", async () => {
		await expect(
			callerAs(db, actorFor(admin)).user.setRole({ userId: admin.id, role: "user" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		await expect(
			callerAs(db, actorFor(admin)).user.delete({ userId: admin.id }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("revokes sessions when a role changes", async () => {
		// Bob signs in...
		const session = await callerAs(db, null).auth.login({
			email: "bob@example.com",
			password: "password123",
		});
		expect(session.role).toBe("user");

		const before = await db.query.refreshTokens.findFirst();
		expect(before?.revokedAt).toBeNull();

		// ...an admin changes his role...
		await callerAs(db, actorFor(admin)).user.setRole({ userId: member.id, role: "admin" });

		// ...and his refresh token is dead, so the stale "user" access token cannot be
		// renewed. Without this, a demotion would linger for the life of the token.
		const after = await db.query.refreshTokens.findFirst();
		expect(after?.revokedAt).toBeInstanceOf(Date);
	});

	it("deletes a user and their posts with them", async () => {
		await callerAs(db, actorFor(member)).post.create({ title: "Bob's", body: "x" });

		await expect(
			callerAs(db, actorFor(admin)).user.delete({ userId: member.id }),
		).resolves.toEqual({ id: member.id });

		// The posts went with the cascade in db/schema.ts.
		await expect(callerAs(db, actorFor(admin)).post.list({})).resolves.toEqual({
			items: [],
			nextCursor: null,
		});
	});
});

describe("user.list pagination", () => {
	let db: Database;
	let admin: PublicUser;

	beforeEach(async () => {
		db = await createTestDatabase();

		admin = await seedUser(db, { email: "root@example.com", name: "Root", role: "admin" });
	});

	/** Follows nextCursor to the end and returns each page's names. */
	async function readAll(limit?: number): Promise<string[][]> {
		const pages: string[][] = [];
		let from: { cursor?: string } = {};

		for (let i = 0; i < 50; i++) {
			const page = await callerAs(db, actorFor(admin)).user.list({
				...(limit ? { limit } : {}),
				...from,
			});

			pages.push(page.items.map((user) => user.name));

			if (page.nextCursor === null) return pages;

			from = { cursor: page.nextCursor };
		}

		throw new Error("readAll: still paging after 50 pages");
	}

	/**
	 * Seeds users with created_at one second apart after the admin, oldest first, in one
	 * insert. They never sign in, so they skip seedUser's argon2 hash: a hundred of those
	 * take seconds and time the suite out when it runs in parallel.
	 */
	async function seedMany(count: number): Promise<void> {
		await db.insert(users).values(
			Array.from({ length: count }, (_, i) => ({
				email: `u${i}@example.com`,
				emailKey: `u${i}@example.com`,
				name: `u${i}`,
				passwordHash: "never signs in",
				createdAt: new Date(Date.UTC(2026, 0, 1) + (i + 1) * 1000),
			})),
		);

		await db
			.update(users)
			.set({ createdAt: new Date(Date.UTC(2026, 0, 1)) })
			.where(eq(users.id, admin.id));
	}

	it("answers the admin alone with one page and no cursor", async () => {
		await expect(readAll(1)).resolves.toEqual([["Root"]]);
	});

	it("ends a list of exactly one page size without a cursor to an empty page", async () => {
		await seedMany(2);

		await expect(readAll(3)).resolves.toEqual([["Root", "u0", "u1"]]);
	});

	it("puts the user one over the page size on a second page of its own", async () => {
		await seedMany(3);

		await expect(readAll(3)).resolves.toEqual([["Root", "u0", "u1"], ["u2"]]);
	});

	it("serves a partial last page, oldest first, every user exactly once", async () => {
		await seedMany(6);

		await expect(readAll(3)).resolves.toEqual([
			["Root", "u0", "u1"],
			["u2", "u3", "u4"],
			["u5"],
		]);
	});

	it("serves 20 users when no limit is given", async () => {
		await seedMany(20);

		const pages = await readAll();

		expect(pages.map((page) => page.length)).toEqual([20, 1]);
		expect(pages[1]).toEqual(["u19"]);
	});

	it("serves 100 users at the maximum and refuses 101 rather than clamping", async () => {
		await seedMany(100);

		const page = await callerAs(db, actorFor(admin)).user.list({ limit: 100 });

		expect(page.items).toHaveLength(100);
		expect(page.nextCursor).not.toBeNull();

		for (const limit of [101, 0, -1]) {
			await expect(callerAs(db, actorFor(admin)).user.list({ limit })).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		}
	});

	it("neither skips nor repeats users who signed up in the same instant", async () => {
		await seedMany(4);
		await db.update(users).set({ createdAt: new Date(Date.UTC(2026, 0, 1)) });

		const all = await db.select({ id: users.id, name: users.name }).from(users);
		const byIdAsc = all.sort((x, y) => (x.id < y.id ? -1 : 1)).map((user) => user.name);

		const pages = await readAll(2);

		expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
		expect(pages.flat()).toEqual(byIdAsc);
	});

	it("never selects a password hash on any page", async () => {
		await seedMany(2);

		const first = await callerAs(db, actorFor(admin)).user.list({ limit: 2 });
		const second = await callerAs(db, actorFor(admin)).user.list({
			cursor: first.nextCursor ?? "",
		});

		for (const user of [...first.items, ...second.items]) {
			expect(Object.keys(user)).not.toContain("passwordHash");
		}
	});

	it("refuses a cursor from post.list, and a malformed one, with BAD_REQUEST", async () => {
		const fromPosts = encodeCursor("posts", {
			at: "2026-01-01T00:00:00.000000Z",
			id: admin.id,
		});

		for (const cursor of [fromPosts, "not a cursor!", "bm9wZQ"]) {
			await expect(callerAs(db, actorFor(admin)).user.list({ cursor })).rejects.toMatchObject(
				{ code: "BAD_REQUEST" },
			);
		}
	});

	it("checks the role before the cursor, so a non-admin learns nothing from one", async () => {
		const bob = await seedUser(db, { email: "bob@example.com", name: "Bob" });

		await expect(
			callerAs(db, actorFor(bob)).user.list({ cursor: "not a cursor!" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(callerAs(db, null).user.list({ cursor: "bm9wZQ" })).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});
});
