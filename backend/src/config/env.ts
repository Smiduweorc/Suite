import { type } from "arktype";

/**
 * Two RFC 1123 labels or more. A single label ("localhost", a container name)
 * cannot work: a Domain attribute has to be a suffix of the request host, and
 * browsers drop a cookie whose Domain is not.
 */
const CookieDomain = type(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i).describe(
	'a bare parent domain like "example.com": no scheme, no port, no path, at least two labels (leave COOKIE_DOMAIN unset on localhost or where one host serves everything)',
);

/**
 * No "none": a cross-site token cookie is what CSRF exploits. The description names the
 * way out for a frontend on a different registrable domain.
 */
const SameSite = type("'lax' | 'strict'").describe(
	'"lax" or "strict" (a frontend on a different registrable domain has to reach this API through one shared origin, for instance a reverse proxy mounting /trpc under the app\'s domain)',
);

/**
 * lacewing's duration syntax ("30s", "15m", "1h"), restated because its parser is not
 * exported. A string lacewing would refuse must be refused here instead: otherwise it
 * boots, and the first login is a 500 when the token refuses to sign.
 */
const DURATION = /^(\d{1,9})(s|m|h|d)$/;
const SECONDS_PER = { s: 1, m: 60, h: 3600, d: 86400 } as const;

/** lacewing's default ceiling on an access token's lifetime. */
const MAX_ACCESS_SECONDS = 3600;

function seconds(value: string): number | undefined {
	const match = DURATION.exec(value);

	if (!match?.[1] || !match[2]) return undefined;

	return Number(match[1]) * SECONDS_PER[match[2] as keyof typeof SECONDS_PER];
}

const AccessExpiry = type("string").narrow((value, ctx) => {
	const total = seconds(value);

	return (
		(total !== undefined && total >= 1 && total <= MAX_ACCESS_SECONDS) ||
		ctx.mustBe('a lifetime between 1s and 1h, written like "15m" or "3600s"')
	);
});

const Env = type({
	NODE_ENV: "'development' | 'test' | 'production'",
	PORT: "1 <= number <= 65535",
	GRPC_PORT: "1 <= number <= 65535",
	LOG_LEVEL: "'debug' | 'info' | 'warn' | 'error' | 'silent'",
	// Tags every log line, so one stream can carry more than one service.
	SERVICE_NAME: "string > 0",
	DATABASE_URL: "string > 0",
	// Connected lazily, never awaited at boot: an outage degrades the feed to a cache miss
	// and refuses idempotent writes with a 503 instead of stopping the app.
	REDIS_URL: "string > 0",
	CORS_ORIGIN: "string > 0",

	// lacewing also entropy-checks it: a human-chosen passphrase, even a long one, throws
	// EntropyCheckFailed. Generate one with `openssl rand -base64 48`.
	JWT_SECRET: "string >= 32",
	JWT_ACCESS_EXPIRY: AccessExpiry,
	// `iss`/`aud` are pinned at verification; a token minted for another
	// deployment fails here regardless of its signature.
	JWT_ISSUER: "string > 0",
	JWT_AUDIENCE: "string > 0",
	REFRESH_TOKEN_TTL_DAYS: "1 <= number <= 365",

	COOKIE_SAME_SITE: SameSite,
	// When to set it: backend/.env.example.
	"COOKIE_DOMAIN?": CookieDomain,
});

const cookieDomain = (process.env.COOKIE_DOMAIN ?? "").trim().replace(/^\./, "");

/** A number when the variable is set, absent otherwise, so a missing one is reported as missing. */
function numeric(value: string | undefined): number | undefined {
	return value === undefined ? undefined : Number(value);
}

// Defaults are applied before validation so the schema stays a plain shape check.
// Only ports, log level, service name and cookie policy have one: a localhost fallback
// for who to trust, where to connect or how long a session lives turns a deployment
// mistake into a server that boots and trusts the wrong thing.
const result = Env({
	NODE_ENV: process.env.NODE_ENV ?? "development",
	PORT: Number(process.env.PORT ?? 3000),
	GRPC_PORT: Number(process.env.GRPC_PORT ?? 50051),
	LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
	SERVICE_NAME: process.env.SERVICE_NAME ?? "bevd-lacewing-backend",
	DATABASE_URL: process.env.DATABASE_URL,
	REDIS_URL: process.env.REDIS_URL,
	CORS_ORIGIN: process.env.CORS_ORIGIN,
	JWT_SECRET: process.env.JWT_SECRET,
	JWT_ACCESS_EXPIRY: process.env.JWT_ACCESS_EXPIRY,
	JWT_ISSUER: process.env.JWT_ISSUER,
	JWT_AUDIENCE: process.env.JWT_AUDIENCE,
	REFRESH_TOKEN_TTL_DAYS: numeric(process.env.REFRESH_TOKEN_TTL_DAYS),
	COOKIE_SAME_SITE: process.env.COOKIE_SAME_SITE ?? "lax",
	// Absent rather than "", because absent leaves the cookies host-only. RFC 6265
	// reads ".example.com" and "example.com" alike, so the dot is stripped above.
	...(cookieDomain ? { COOKIE_DOMAIN: cookieDomain } : {}),
});

if (result instanceof type.errors) {
	throw new Error(
		`Invalid environment:\n${result.summary}\n\nDid you copy .env.example to .env?`,
	);
}

export const env = result;
export type Env = typeof env;

const accessSeconds = seconds(env.JWT_ACCESS_EXPIRY);

if (accessSeconds === undefined) {
	throw new Error("JWT_ACCESS_EXPIRY passed validation but could not be read");
}

/** The access cookie's Max-Age, so the cookie and the token inside it expire together. */
export const accessTokenSeconds = accessSeconds;
