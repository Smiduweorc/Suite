import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

/**
 * `pg` waits forever by default, for a connection and for a query. Every query this app
 * makes is a lookup by key or an indexed read of at most 100 rows, so:
 *
 * - connectionTimeoutMillis, 3s: covers the handshake and the wait for a free pool slot.
 *   A host that accepts the socket and never answers otherwise hangs the request for good.
 * - statement_timeout, 5s: Postgres cancels the query itself. Anything this slow here is
 *   a held lock or an outage, not a query that needs more time.
 * - query_timeout, 6s: the client's own limit, for a connection that dies mid-query and
 *   so never delivers the server's cancellation. Above statement_timeout so the server's
 *   error, which names the cause, normally arrives first.
 *
 * The feed's firefly deadline (2s, suite/index.ts) is tighter and sits outside these.
 */
export function createDatabase(connectionString: string): { db: Database; pool: Pool } {
	const pool = new Pool({
		connectionString,
		connectionTimeoutMillis: 3_000,
		statement_timeout: 5_000,
		query_timeout: 6_000,
	});
	const db = drizzle(pool, { schema });

	return { db, pool };
}

/** For the readiness probe. Here rather than in the router: routers hold no queries. */
export async function pingDatabase(db: Database): Promise<void> {
	await db.execute(sql`select 1`);
}

export { schema };
