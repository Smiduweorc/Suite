import { beforeEach, describe, expect, it } from "bun:test";
import { type SQL, sql } from "drizzle-orm";
import type { Database } from "../../../db";
import { type PublicUser, posts } from "../../../db/schema";
import { encodeCursor } from "../../../services/page";
import { actorFor, seedUser } from "../../../test/auth";
import { callerAs } from "../../../test/context";
import { createTestDatabase } from "../../../test/db";

describe("post authorization", () => {
	let db: Database;
	let alice: PublicUser;
	let bob: PublicUser;
	let admin: PublicUser;

	beforeEach(async () => {
		db = await createTestDatabase();

		alice = await seedUser(db, { email: "alice@example.com", name: "Alice" });
		bob = await seedUser(db, { email: "bob@example.com", name: "Bob" });
		admin = await seedUser(db, { email: "root@example.com", name: "Root", role: "admin" });
	});

	it("refuses to create a post for an anonymous caller", async () => {
		const anon = callerAs(db, null);

		await expect(anon.post.create({ title: "Nope", body: "x" })).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});

	it("takes the author from the token, not from the request", async () => {
		const post = await callerAs(db, actorFor(alice)).post.create({ title: "Mine", body: "x" });

		expect(post.authorId).toBe(alice.id);
	});

	it("hides other people's drafts but shows your own", async () => {
		await callerAs(db, actorFor(alice)).post.create({ title: "Alice draft", body: "x" });
		await callerAs(db, actorFor(bob)).post.create({
			title: "Bob published",
			body: "y",
			published: true,
		});

		const { items: anonSees } = await callerAs(db, null).post.list({});
		expect(anonSees.map((p) => p.title)).toEqual(["Bob published"]);

		const { items: bobSees } = await callerAs(db, actorFor(bob)).post.list({});
		expect(bobSees.map((p) => p.title)).toEqual(["Bob published"]);

		const { items: aliceSees } = await callerAs(db, actorFor(alice)).post.list({});
		expect(aliceSees.map((p) => p.title).sort()).toEqual(["Alice draft", "Bob published"]);

		const { items: adminSees } = await callerAs(db, actorFor(admin)).post.list({});
		expect(adminSees).toHaveLength(2);
	});

	it("reports someone else's draft as NOT_FOUND, not FORBIDDEN", async () => {
		const draft = await callerAs(db, actorFor(alice)).post.create({
			title: "Secret",
			body: "x",
		});

		// FORBIDDEN would confirm the post exists. That is itself a leak.
		await expect(callerAs(db, actorFor(bob)).post.byId({ id: draft.id })).rejects.toMatchObject(
			{
				code: "NOT_FOUND",
			},
		);

		await expect(
			callerAs(db, actorFor(admin)).post.byId({ id: draft.id }),
		).resolves.toMatchObject({ title: "Secret" });
	});

	it("stops one user editing another's post", async () => {
		const post = await callerAs(db, actorFor(alice)).post.create({
			title: "Alice's",
			body: "x",
			published: true,
		});

		await expect(
			callerAs(db, actorFor(bob)).post.update({ id: post.id, title: "Hijacked" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		await expect(
			callerAs(db, actorFor(bob)).post.delete({ id: post.id }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		// Untouched.
		await expect(
			callerAs(db, actorFor(alice)).post.byId({ id: post.id }),
		).resolves.toMatchObject({
			title: "Alice's",
		});
	});

	it("lets the author edit their own post", async () => {
		const post = await callerAs(db, actorFor(alice)).post.create({ title: "Draft", body: "x" });

		const updated = await callerAs(db, actorFor(alice)).post.update({
			id: post.id,
			title: "Better",
		});

		expect(updated.title).toBe("Better");
	});

	it("lets an admin edit and delete anyone's post", async () => {
		const post = await callerAs(db, actorFor(alice)).post.create({
			title: "Alice's",
			body: "x",
			published: true,
		});

		const updated = await callerAs(db, actorFor(admin)).post.update({
			id: post.id,
			published: false,
		});
		expect(updated.published).toBe(false);

		await expect(callerAs(db, actorFor(admin)).post.delete({ id: post.id })).resolves.toEqual({
			id: post.id,
		});
	});

	it("still validates input", async () => {
		await expect(
			callerAs(db, actorFor(alice)).post.create({ title: "", body: "x" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

const JAN_1 = Date.UTC(2026, 0, 1);

interface Row {
	title: string;
	/** Defaults to one second apart, in the order given, so the last row is the newest. */
	createdAt?: Date | SQL;
	published?: boolean;
}

/** Inserts posts directly, so a test controls created_at to the microsecond. */
async function insertPosts(db: Database, authorId: string, rows: Row[]): Promise<void> {
	await db.insert(posts).values(
		rows.map(({ title, createdAt, published = true }, i) => ({
			title,
			body: "x",
			published,
			authorId,
			createdAt: createdAt ?? new Date(JAN_1 + i * 1000),
		})),
	);
}

function titled(prefix: string, count: number): Row[] {
	return Array.from({ length: count }, (_, i) => ({ title: `${prefix}${i}` }));
}

interface Listed {
	items: { title: string }[];
	nextCursor: string | null;
}

/**
 * Follows nextCursor to the end and returns each page's titles. The first call gets `{}`
 * and later ones `{ cursor }`: the key is absent rather than undefined, as it is once
 * JSON has carried it over HTTP.
 */
async function readAll(read: (from: { cursor?: string }) => Promise<Listed>): Promise<string[][]> {
	const pages: string[][] = [];
	let from: { cursor?: string } = {};

	for (let i = 0; i < 50; i++) {
		const page = await read(from);

		pages.push(page.items.map((post) => post.title));

		if (page.nextCursor === null) return pages;

		from = { cursor: page.nextCursor };
	}

	throw new Error("readAll: still paging after 50 pages");
}

describe("post.list pagination", () => {
	let db: Database;
	let alice: PublicUser;
	let bob: PublicUser;

	beforeEach(async () => {
		db = await createTestDatabase();

		alice = await seedUser(db, { email: "alice@example.com", name: "Alice" });
		bob = await seedUser(db, { email: "bob@example.com", name: "Bob" });
	});

	const anon = () => callerAs(db, null);

	it("answers an empty table with one empty page and no cursor", async () => {
		await expect(anon().post.list({ limit: 3 })).resolves.toEqual({
			items: [],
			nextCursor: null,
		});
	});

	it("answers a single post with one page and no cursor", async () => {
		await insertPosts(db, alice.id, titled("p", 1));

		await expect(readAll((from) => anon().post.list({ limit: 3, ...from }))).resolves.toEqual([
			["p0"],
		]);
	});

	it("ends a list of exactly one page size without a cursor to an empty page", async () => {
		await insertPosts(db, alice.id, titled("p", 3));

		await expect(readAll((from) => anon().post.list({ limit: 3, ...from }))).resolves.toEqual([
			["p2", "p1", "p0"],
		]);
	});

	it("puts the post one over the page size on a second page of its own", async () => {
		await insertPosts(db, alice.id, titled("p", 4));

		await expect(readAll((from) => anon().post.list({ limit: 3, ...from }))).resolves.toEqual([
			["p3", "p2", "p1"],
			["p0"],
		]);
	});

	it("serves a partial last page, newest first, every post exactly once", async () => {
		await insertPosts(db, alice.id, titled("p", 7));

		await expect(readAll((from) => anon().post.list({ limit: 3, ...from }))).resolves.toEqual([
			["p6", "p5", "p4"],
			["p3", "p2", "p1"],
			["p0"],
		]);
	});

	it("serves 20 posts when no limit is given", async () => {
		await insertPosts(db, alice.id, titled("p", 21));

		const first = await anon().post.list({});

		expect(first.items).toHaveLength(20);
		expect(first.items[0]?.title).toBe("p20");
		expect(first.items[19]?.title).toBe("p1");
		expect(first.nextCursor).not.toBeNull();

		const second = await anon().post.list({ cursor: first.nextCursor ?? "" });

		expect(second).toMatchObject({ items: [{ title: "p0" }], nextCursor: null });
	});

	it("serves 100 posts at the maximum and refuses 101 rather than clamping", async () => {
		await insertPosts(db, alice.id, titled("p", 101));

		const page = await anon().post.list({ limit: 100 });

		expect(page.items).toHaveLength(100);
		expect(page.nextCursor).not.toBeNull();

		for (const limit of [101, 0, -1, 1.5]) {
			await expect(anon().post.list({ limit })).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		}
	});

	it("neither skips nor repeats posts that share a created_at", async () => {
		const at = new Date(JAN_1);
		await insertPosts(
			db,
			alice.id,
			["a", "b", "c", "d", "e"].map((title) => ({ title, createdAt: at })),
		);

		const all = await db.select({ id: posts.id, title: posts.title }).from(posts);
		const byIdDesc = all.sort((x, y) => (x.id < y.id ? 1 : -1)).map((post) => post.title);

		const pages = await readAll((from) => anon().post.list({ limit: 2, ...from }));

		expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
		expect(pages.flat()).toEqual(byIdDesc);
	});

	it("neither skips nor repeats posts a microsecond apart inside one millisecond", async () => {
		// A JS Date cannot tell these apart, so a cursor built from one would skip or repeat
		// them.
		await insertPosts(
			db,
			alice.id,
			[1, 2, 3, 4].map((us) => ({
				title: `us${us}`,
				createdAt: sql`${`2026-01-01T00:00:00.00000${us}Z`}::timestamptz`,
			})),
		);

		for (const limit of [1, 2, 3]) {
			const pages = await readAll((from) => anon().post.list({ limit, ...from }));

			expect(pages.flat()).toEqual(["us4", "us3", "us2", "us1"]);
		}
	});

	it("keeps another user's drafts off every page and out of the page count", async () => {
		await insertPosts(db, alice.id, [
			{ title: "live0" },
			{ title: "draft1", published: false },
			{ title: "live2" },
			{ title: "draft3", published: false },
			{ title: "live4" },
			{ title: "live5" },
			{ title: "draft6", published: false },
		]);

		const asBob = (from: { cursor?: string }) =>
			callerAs(db, actorFor(bob)).post.list({ limit: 2, ...from });

		// Full pages of what Bob may see, and no third, empty page: the newest row is a
		// draft and the oldest is live, so the look-ahead row was filtered too.
		await expect(readAll(asBob)).resolves.toEqual([
			["live5", "live4"],
			["live2", "live0"],
		]);
		await expect(readAll((from) => anon().post.list({ limit: 2, ...from }))).resolves.toEqual([
			["live5", "live4"],
			["live2", "live0"],
		]);

		await expect(
			readAll((from) => callerAs(db, actorFor(alice)).post.list({ limit: 3, ...from })),
		).resolves.toEqual([
			["draft6", "live5", "live4"],
			["draft3", "live2", "draft1"],
			["live0"],
		]);
	});

	it("does not offer a next page when only someone else's draft lies beyond", async () => {
		await insertPosts(db, alice.id, [
			{ title: "draft0", published: false },
			{ title: "live1" },
			{ title: "live2" },
		]);

		await expect(callerAs(db, actorFor(bob)).post.list({ limit: 2 })).resolves.toMatchObject({
			items: [{ title: "live2" }, { title: "live1" }],
			nextCursor: null,
		});
	});

	it("keeps the author's own drafts out of every page when publishedOnly is set", async () => {
		await insertPosts(db, alice.id, [
			{ title: "live0" },
			{ title: "draft1", published: false },
			{ title: "live2" },
		]);

		await expect(
			readAll((from) =>
				callerAs(db, actorFor(alice)).post.list({ limit: 1, publishedOnly: true, ...from }),
			),
		).resolves.toEqual([["live2"], ["live0"]]);
	});

	it("does not reveal a draft to a caller who forges a cursor next to it", async () => {
		await insertPosts(db, alice.id, [
			{ title: "live0" },
			{ title: "draft1", published: false },
		]);
		const [draft] = await db.select().from(posts).where(sql`${posts.title} = 'draft1'`);

		const forged = encodeCursor("posts", {
			at: "2026-01-01T00:00:02.000000Z",
			id: draft?.id ?? "",
		});

		await expect(
			callerAs(db, actorFor(bob)).post.list({ cursor: forged }),
		).resolves.toMatchObject({ items: [{ title: "live0" }], nextCursor: null });
	});

	it("refuses a malformed or tampered cursor with BAD_REQUEST", async () => {
		await insertPosts(db, alice.id, titled("p", 3));

		const { nextCursor } = await anon().post.list({ limit: 1 });
		const good = nextCursor ?? "";
		const id = "99999999-9999-4999-8999-999999999999";
		const raw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

		const refused = {
			"not base64url": "not a cursor!",
			empty: "",
			"too long": "A".repeat(201),
			"not JSON": Buffer.from("posts|2026|x").toString("base64url"),
			"a trailing character": `${good}A`,
			"a missing character": good.slice(0, -1),
			"the users list's": raw(["users", "2026-01-01T00:00:00.000000Z", id]),
			"an unknown list's": raw(["drafts", "2026-01-01T00:00:00.000000Z", id]),
			"a missing part": raw(["posts", "2026-01-01T00:00:00.000000Z"]),
			"an extra part": raw(["posts", "2026-01-01T00:00:00.000000Z", id, "x"]),
			"an object": raw({ at: "2026-01-01T00:00:00.000000Z", id }),
			"a non-uuid id": raw(["posts", "2026-01-01T00:00:00.000000Z", "1 OR 1=1"]),
			"millisecond precision": raw(["posts", "2026-01-01T00:00:00.000Z", id]),
			"an offset": raw(["posts", "2026-01-01T00:00:00.000000+01:00", id]),
			"February 30th": raw(["posts", "2026-02-30T00:00:00.000000Z", id]),
			"hour 24": raw(["posts", "2026-01-01T24:00:00.000000Z", id]),
			"year 0": raw(["posts", "0000-01-01T00:00:00.000000Z", id]),
			"SQL in the timestamp": raw(["posts", "2026-01-01'); DROP TABLE posts; --", id]),
		};

		for (const [what, cursor] of Object.entries(refused)) {
			await expect(
				anon().post.list({ cursor }),
				`a cursor with ${what} was accepted`,
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}

		// The good one still works, and the table is still there.
		await expect(anon().post.list({ cursor: good })).resolves.toMatchObject({
			items: [{ title: "p1" }, { title: "p0" }],
		});
	});
});
