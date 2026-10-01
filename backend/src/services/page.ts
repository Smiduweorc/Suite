import { type } from "arktype";
import { asc, desc, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { AppError, parseInput } from "../lib/errors";

/** `nextCursor` is null on the last page, and only then. */
export interface Page<T> {
	items: T[];
	nextCursor: string | null;
}

export const DEFAULT_PAGE_SIZE = 20;

/** A larger `limit` is refused, never clamped. */
export const MAX_PAGE_SIZE = 100;

/**
 * Checks only that the cursor is a plausible token; `decodeCursor` checks what it says.
 * tRPC hands the resolver this schema's output and the service parses it again, so a
 * morph here would run twice.
 */
export const PageInput = type({
	"limit?": `1 <= number.integer <= ${MAX_PAGE_SIZE}`,
	"cursor?": /^[A-Za-z0-9_-]{1,200}$/,
});

/** Which list a cursor belongs to. A posts cursor sent to user.list is refused. */
export type ListName = "posts" | "users";

/** [list, created_at as positionOf formats it, id] */
const CursorPayload = type([
	"'posts' | 'users'",
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
	"string.uuid",
]);

interface Position {
	at: string;
	id: string;
}

/**
 * created_at at full precision, for the cursor. Postgres keeps microseconds and a JS Date
 * keeps milliseconds, so a cursor built from the Date would sit up to 999us before or
 * after the row it names, and rows in that gap would be skipped or served twice. So
 * Postgres formats the position, always in UTC, and `after` casts it back to timestamptz.
 */
export function positionOf(createdAt: PgColumn): SQL<string> {
	return sql<string>`to_char(${createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

export function encodeCursor(list: ListName, position: Position): string {
	return Buffer.from(JSON.stringify([list, position.at, position.id])).toString("base64url");
}

/**
 * Not signed: the query still applies the caller's visibility rule, so a hand-made cursor
 * only starts the list somewhere the caller could have paged to. It must never reach
 * Postgres malformed, where a bad timestamp is a 500.
 */
export function decodeCursor(list: ListName, cursor: string): Position {
	const bytes = Buffer.from(cursor, "base64url");

	// Node's base64url decoder skips characters it does not understand and ignores
	// trailing bits. Re-encoding catches both, so one token means one position.
	if (bytes.toString("base64url") !== cursor) {
		throw new AppError("BAD_REQUEST", "Malformed cursor");
	}

	let decoded: unknown;

	try {
		decoded = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new AppError("BAD_REQUEST", "Malformed cursor");
	}

	const [owner, at, id] = parseInput(CursorPayload, decoded);

	if (owner !== list) {
		throw new AppError("BAD_REQUEST", `That cursor belongs to the ${owner} list`);
	}

	// The pattern lets 2026-02-30 and 25:00 through, and Postgres answers those with an
	// error. A date that does not survive a round trip through Date did not exist. Year 0
	// does survive it, and Postgres has no year 0.
	const millis = `${at.slice(0, 23)}Z`;
	const date = new Date(millis);

	if (
		Number.isNaN(date.getTime()) ||
		date.toISOString() !== millis ||
		date.getUTCFullYear() < 1
	) {
		throw new AppError("BAD_REQUEST", "Malformed cursor");
	}

	return { at, id };
}

interface Keyset {
	createdAt: PgColumn;
	id: PgColumn;
	/** newest first, or oldest first. id breaks ties in the same direction. */
	direction: "desc" | "asc";
}

/** ORDER BY for a keyset: total, because id is unique. */
export function keysetOrder({ createdAt, id, direction }: Keyset): SQL[] {
	const by = direction === "desc" ? desc : asc;

	return [by(createdAt), by(id)];
}

/**
 * The rows strictly after `position` in keyset order. A row comparison, so Postgres
 * walks the (created_at, id) index from the cursor rather than filtering the table.
 */
export function after({ createdAt, id, direction }: Keyset, position: Position): SQL {
	return direction === "desc"
		? sql`(${createdAt}, ${id}) < (${position.at}::timestamptz, ${position.id}::uuid)`
		: sql`(${createdAt}, ${id}) > (${position.at}::timestamptz, ${position.id}::uuid)`;
}

/**
 * Cuts a page from rows fetched with `limit + 1`. The extra row is how we know another
 * page exists without a COUNT, and it was fetched under the same WHERE as the page, so a
 * row the caller may not see never turns into a cursor.
 */
export function toPage<T extends { id: string }>(
	list: ListName,
	rows: { row: T; at: string }[],
	limit: number,
): Page<T> {
	const page = rows.slice(0, limit);
	const last = page.at(-1);

	return {
		items: page.map(({ row }) => row),
		nextCursor:
			rows.length > limit && last
				? encodeCursor(list, { at: last.at, id: last.row.id })
				: null,
	};
}
