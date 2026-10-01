import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Database } from "../db";
import * as schema from "../db/schema";

const MIGRATIONS_FOLDER = new URL("../../drizzle", import.meta.url).pathname;

/**
 * The cast: PGlite and node-postgres Drizzle types differ by driver generic, though every
 * query here is identical across the two. Migrations come from the production `drizzle/`
 * folder, so schema drift still fails the suite.
 */
export async function createTestDatabase(): Promise<Database> {
	const client = new PGlite();
	const db = drizzle(client, { schema });

	await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

	return db as unknown as Database;
}
