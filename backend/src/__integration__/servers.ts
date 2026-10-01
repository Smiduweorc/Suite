import { afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Redis } from "ioredis";
import { Client, Pool } from "pg";

const MIGRATIONS_FOLDER = new URL("../../drizzle", import.meta.url).pathname;

/**
 * Called at the top of each test file under src/__integration__/, which `bun run
 * test:integration` runs and `bun run test` ignores.
 *
 * INTEGRATION_DATABASE_URL: a role that may CREATE DATABASE. Each file creates its own
 * database on that server, applies drizzle/ to it, and drops it when the file is done, so
 * pointing this at the docker-compose Postgres leaves the dev data alone.
 *
 * INTEGRATION_REDIS_URL: any Redis. Each file writes under its own key prefix and deletes
 * only that, never FLUSHDB.
 *
 * Unset, the tests that need it are skipped and reported as skipped. Under CI (which
 * GitHub sets) unset is an error instead: a job that skips everything would go green.
 */
function required(name: "INTEGRATION_DATABASE_URL" | "INTEGRATION_REDIS_URL"): string {
	const value = process.env[name] ?? "";

	if (value === "") {
		if (process.env.CI) {
			throw new Error(`${name} must be set in CI, or every integration test is skipped`);
		}

		process.stderr.write(
			`\n${name} not set: tests against an unset server are SKIPPED, not passed.\n` +
				"Start the servers with `bun run db:up` and see backend/src/__integration__/servers.ts.\n\n",
		);
	}

	return value;
}

/** This file's own database, migrated, or "" when INTEGRATION_DATABASE_URL is unset. */
export async function integrationDatabase(): Promise<string> {
	const adminUrl = required("INTEGRATION_DATABASE_URL");

	if (adminUrl === "") return "";

	const runId = randomUUID().slice(0, 8);
	const databaseUrl = await createDatabase(adminUrl, runId);

	afterAll(() => dropDatabase(adminUrl, runId));

	return databaseUrl;
}

/**
 * `redisUrl` is "" when INTEGRATION_REDIS_URL is unset. Every key written starts with
 * `namespace`, and is deleted when the file is done.
 */
export function integrationRedis(): { redisUrl: string; namespace: string } {
	const redisUrl = required("INTEGRATION_REDIS_URL");
	const namespace = `suite-it-${randomUUID().slice(0, 8)}`;

	if (redisUrl !== "") afterAll(() => deleteKeys(redisUrl, namespace));

	return { redisUrl, namespace };
}

/** Hex from a UUID, so the name needs no quoting and cannot inject anything. */
function databaseName(runId: string): string {
	return `suite_it_${runId}`;
}

async function admin<T>(adminUrl: string, run: (client: Client) => Promise<T>): Promise<T> {
	// A wrong host fails in 3s instead of hanging the whole run.
	const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 3_000 });

	await client.connect();

	try {
		return await run(client);
	} finally {
		await client.end();
	}
}

async function createDatabase(adminUrl: string, runId: string): Promise<string> {
	const name = databaseName(runId);

	await admin(adminUrl, (client) => client.query(`CREATE DATABASE ${name}`));

	const url = new URL(adminUrl);
	url.pathname = `/${name}`;

	const pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 3_000 });

	try {
		await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
	} catch (error) {
		await pool.end();
		await dropDatabase(adminUrl, runId);
		throw error;
	}

	await pool.end();

	return url.href;
}

async function dropDatabase(adminUrl: string, runId: string): Promise<void> {
	// FORCE: a test that failed before closing its pool still holds connections.
	await admin(adminUrl, (client) =>
		client.query(`DROP DATABASE IF EXISTS ${databaseName(runId)} WITH (FORCE)`),
	);
}

async function deleteKeys(redisUrl: string, namespace: string): Promise<void> {
	const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 3_000 });

	try {
		const batches: AsyncIterable<string[]> = redis.scanStream({ match: `${namespace}:*` });

		for await (const keys of batches) {
			if (keys.length > 0) await redis.del(...keys);
		}
	} finally {
		redis.disconnect();
	}
}
