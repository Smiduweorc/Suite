import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { AppError } from "../../lib/errors";
import { serviceCtx } from "../../test/context";
import { createTestDatabase } from "../../test/db";
import { DEFAULT_PAGE_SIZE, decodeCursor, encodeCursor, MAX_PAGE_SIZE, toPage } from "../page";
import { listPosts } from "../post.service";

const ID = "0c8f3c9e-4b5a-4d1e-9f2a-7b6c5d4e3f21";
const AT = "2026-03-14T15:09:26.535897Z";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Every cursor one character away from `cursor`: each position, each base64url letter. */
function neighbours(cursor: string): string[] {
	const out: string[] = [];

	for (let i = 0; i < cursor.length; i++) {
		for (const letter of BASE64URL) {
			if (letter !== cursor[i]) out.push(cursor.slice(0, i) + letter + cursor.slice(i + 1));
		}
	}

	return out;
}

/** The decoded position, or "refused" for a BAD_REQUEST. Anything else is rethrown. */
function outcome(cursor: string): { at: string; id: string } | "refused" {
	try {
		return decodeCursor("posts", cursor);
	} catch (error) {
		if (error instanceof AppError && error.code === "BAD_REQUEST") return "refused";

		throw error;
	}
}

describe("page sizes", () => {
	it("defaults to 20 rows and caps at 100", () => {
		expect(DEFAULT_PAGE_SIZE).toBe(20);
		expect(MAX_PAGE_SIZE).toBe(100);
	});
});

describe("cursors", () => {
	it("round-trips a position exactly, microseconds included", () => {
		expect(decodeCursor("posts", encodeCursor("posts", { at: AT, id: ID }))).toEqual({
			at: AT,
			id: ID,
		});
		expect(decodeCursor("users", encodeCursor("users", { at: AT, id: ID }))).toEqual({
			at: AT,
			id: ID,
		});
	});

	it("is refused by the other list", () => {
		expect(outcome(encodeCursor("users", { at: AT, id: ID }))).toBe("refused");
	});

	it("is refused when truncated to any length", () => {
		const cursor = encodeCursor("posts", { at: AT, id: ID });

		for (let length = 0; length < cursor.length; length++) {
			expect(outcome(cursor.slice(0, length)), `length ${length}`).toBe("refused");
		}
	});

	it("is refused or names a well-formed position after any one-character change", async () => {
		const cursor = encodeCursor("posts", { at: AT, id: ID });
		const accepted: { cursor: string; at: string; id: string }[] = [];

		for (const changed of neighbours(cursor)) {
			const result = outcome(changed);

			if (result === "refused") continue;

			accepted.push({ cursor: changed, ...result });
			expect(result.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
			expect(result.id).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
			);
		}

		// Some changes land on another valid position: a different digit in the time, or
		// in the id. 428 of the 6552 do, for this cursor. Postgres must take every one of
		// them, because a cursor that passes here and fails there is a 500. One statement
		// casts them all the way listPosts does; a spread of them also goes through
		// listPosts itself.
		expect(accepted).toHaveLength(428);

		const db = await createTestDatabase();
		const casts = sql.join(
			accepted.map(({ at, id }) => sql`(${at}::timestamptz, ${id}::uuid)`),
			sql`, `,
		);

		const cast = await db.execute(sql`select * from (values ${casts}) as t(at, id)`);
		expect(cast.rows).toHaveLength(428);

		for (const { cursor: changed } of accepted.filter((_, i) => i % 20 === 0)) {
			await expect(listPosts(serviceCtx(db), { cursor: changed }), changed).resolves.toEqual({
				items: [],
				nextCursor: null,
			});
		}
	});
});

describe("toPage", () => {
	const rows = (count: number) =>
		Array.from({ length: count }, (_, i) => ({ row: { id: `id${i}` }, at: `at${i}` }));

	it("returns no cursor for no rows", () => {
		expect(toPage("posts", [], 2)).toEqual({ items: [], nextCursor: null });
	});

	it("returns no cursor when the look-ahead row is missing", () => {
		expect(toPage("posts", rows(2), 2)).toEqual({
			items: [{ id: "id0" }, { id: "id1" }],
			nextCursor: null,
		});
	});

	it("drops the look-ahead row and points the cursor at the last row kept", () => {
		const page = toPage("posts", rows(3), 2);

		expect(page.items).toEqual([{ id: "id0" }, { id: "id1" }]);
		expect(page.nextCursor).toBe(
			Buffer.from(JSON.stringify(["posts", "at1", "id1"])).toString("base64url"),
		);
	});
});
