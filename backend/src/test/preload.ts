/**
 * The environment every `bun test` run starts from, loaded through bunfig.toml before any
 * test file. Assigned rather than defaulted: Bun reads backend/.env on its own, and a
 * developer's real values must not leak into the suite.
 *
 * The unit tests never touch the docker-compose database: they run against PGlite, an
 * in-process Postgres. These values only exist to satisfy env validation; the integration
 * tests get their servers from INTEGRATION_*_URL, never from these.
 */
Object.assign(process.env, {
	NODE_ENV: "test",
	PORT: "3000",
	GRPC_PORT: "50051",
	// The logging middleware still runs, it just does not print. Set this to "debug" when
	// a test fails and you want to see what the server saw.
	LOG_LEVEL: "silent",
	SERVICE_NAME: "bevd-lacewing-backend-test",
	DATABASE_URL: "postgres://unused:unused@localhost:5432/unused",
	// Never connected: tests build the suite on the libraries' own MemoryStores.
	REDIS_URL: "redis://unused:6379",
	CORS_ORIGIN: "http://localhost:5173",
	// A throwaway signing key. It has to be random-looking, not just long: lacewing's
	// entropy check has no test-mode bypass, which is the point.
	JWT_SECRET: "KxTa6t5hnM9lWSWZclyiVjcc+E+s7smif8Tvvrorh0TgxU5lzqpu1AsVsQTjMMZb",
	JWT_ACCESS_EXPIRY: "15m",
	JWT_ISSUER: "http://localhost:3000",
	JWT_AUDIENCE: "http://localhost:3000/trpc",
	REFRESH_TOKEN_TTL_DAYS: "7",
	COOKIE_SAME_SITE: "lax",
});

// Optional, so assigning cannot shadow a value from .env: it has to go.
delete process.env.COOKIE_DOMAIN;
