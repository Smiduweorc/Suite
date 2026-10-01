import { afterAll, describe, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { hashRefreshToken } from "../auth/tokens";
import { createDatabase, pingDatabase } from "../db";
import { refreshTokens } from "../db/schema";
import { isConnectionError } from "../lib/errors";
import { refresh, register } from "../services/auth.service";
import { serviceCtx } from "../test/context";
import { integrationDatabase } from "./servers";

const databaseUrl = await integrationDatabase();

describe.skipIf(databaseUrl === "")("on a real Postgres (INTEGRATION_DATABASE_URL)", () => {
	// The production pool, timeouts and all: what is under test is the app's own config.
	const { db, pool } = createDatabase(databaseUrl);

	afterAll(() => pool.end());

	it("lets exactly one of 20 concurrent refreshes with one token have a session", async () => {
		const ctx = serviceCtx(db);
		const session = await register(ctx, {
			email: "refresh-race@example.com",
			name: "Race",
			password: "correct horse battery staple",
		});

		// 20 against a pool of 10: ten transactions hold the token row at once, which is
		// the interleaving a SELECT-then-UPDATE refresh lets more than one of them win.
		const attempts = await Promise.allSettled(
			Array.from({ length: 20 }, () => refresh(ctx, session.refreshToken)),
		);

		const won = attempts.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []));
		const lost = attempts.flatMap((a) => (a.status === "rejected" ? [a.reason] : []));

		expect(won).toHaveLength(1);
		expect(lost).toHaveLength(19);
		for (const reason of lost) expect(reason).toMatchObject({ code: "UNAUTHORIZED" });

		const rows = await db
			.select()
			.from(refreshTokens)
			.where(eq(refreshTokens.userId, session.user.id));
		const live = rows.filter((row) => row.revokedAt === null).map((row) => row.tokenHash);

		// The registration's token, revoked, and the winner's: no session for any loser.
		expect(rows).toHaveLength(2);
		expect(live).toEqual([hashRefreshToken(won[0]?.refreshToken ?? "")]);
	});

	it("has Postgres cancel a statement at 5s with query_canceled, then reuse the connection", async () => {
		const startedAt = performance.now();
		const error = await db.execute(sql`select pg_sleep(10)`).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		const elapsed = performance.now() - startedAt;

		// 57014 is the server's cancellation. pg's own query_timeout (6s) carries no
		// SQLSTATE, so this also fails if that one fired first.
		expect(error).toMatchObject({ cause: { code: "57014" } });
		expect(elapsed).toBeGreaterThanOrEqual(4_900);
		expect(elapsed).toBeLessThan(6_000);
		// A slow query is not an outage: firefly must not retry it.
		expect(isConnectionError(error)).toBe(false);

		await expect(pingDatabase(db)).resolves.toBeUndefined();
	}, 15_000);
});
