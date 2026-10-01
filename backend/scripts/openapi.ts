import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createApp } from "../src/app";
import { createDatabase } from "../src/db";
import { logger } from "../src/lib/logger";
import { createMemorySuite } from "../src/suite";

/**
 * Writes the /api/v1 slice of the OpenAPI document to api-client/openapi.json. No database
 * is needed: `pg` connects lazily and nothing here runs a query. The file is committed so
 * an API change shows up as a diff in review.
 *
 *   bun run openapi   (then `bun run --cwd api-client generate`)
 */
const { db, pool } = createDatabase("postgres://unused@localhost:1/unused");
const app = createApp({ db, log: logger, suite: createMemorySuite(logger) });

const response = await app.handle(new Request("http://localhost/openapi/json"));
const spec = (await response.json()) as { paths: Record<string, unknown> } & Record<
	string,
	unknown
>;

// The mobile client is for /api/v1 only. tRPC is the web app's, and /health a probe's.
spec.paths = Object.fromEntries(
	Object.entries(spec.paths).filter(([path]) => path.startsWith("/api/v1/")),
);

const out = resolve(import.meta.dir, "../../api-client/openapi.json");
await writeFile(out, `${JSON.stringify(spec, null, "\t")}\n`);
await pool.end();

logger.info({ out, paths: Object.keys(spec.paths) }, "openapi written");
