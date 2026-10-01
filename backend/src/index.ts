import { createApp } from "./app";
import { env } from "./config/env";
import { createDatabase } from "./db";
import { createGrpcServer, startGrpcServer } from "./grpc/server";
import { logger } from "./lib/logger";
import { createSuite } from "./suite";
import { createRedis, RedisCacheStore, RedisLedgerStore } from "./suite/redis";

const { db, pool } = createDatabase(env.DATABASE_URL);

const redis = createRedis(env.REDIS_URL, logger);
const suite = createSuite(
	{ cache: new RedisCacheStore(redis), ledger: new RedisLedgerStore(redis) },
	logger,
);

const app = createApp({ db, log: logger, suite });
const grpcServer = createGrpcServer({ db, log: logger, suite });

app.listen(env.PORT, (server) => {
	logger.info(
		{
			rest: `http://${server.hostname}:${server.port}/health`,
			trpc: `http://${server.hostname}:${server.port}/trpc`,
			openapi: `http://${server.hostname}:${server.port}/openapi`,
		},
		"http listening",
	);
});

const grpcPort = await startGrpcServer(grpcServer, env.GRPC_PORT);

logger.info({ address: `0.0.0.0:${grpcPort}` }, "grpc listening");

const DRAIN_TIMEOUT_MS = 10_000;

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
	// A second Ctrl-C should not start a second teardown.
	if (shuttingDown) return;
	shuttingDown = true;

	logger.info({ signal }, "shutting down");

	await app.stop();

	// Without a deadline on tryShutdown, one hung stream keeps the pod alive until the
	// orchestrator kills it.
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			logger.warn({ timeoutMs: DRAIN_TIMEOUT_MS }, "grpc drain timed out, forcing");
			grpcServer.forceShutdown();
			resolve();
		}, DRAIN_TIMEOUT_MS);

		grpcServer.tryShutdown(() => {
			clearTimeout(timer);
			resolve();
		});
	});

	// Background cache refreshes are never awaited by a reader, and each one queries
	// Postgres and writes to Redis: let them land before either goes away.
	await suite.feed.settled();
	await pool.end();
	redis.disconnect();

	logger.info("stopped");
	process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => void shutdown(signal));
}

export type { AppRouter } from "./trpc/routers";
