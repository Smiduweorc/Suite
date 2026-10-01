import { type Type, type } from "arktype";

/**
 * The one error vocabulary. Services throw these; each transport maps the code to its own
 * status (trpc/trpc.ts, grpc/server.ts). Anything that is not an AppError is a bug: logged
 * with its stack and reported to the caller as a bare internal error with a request id.
 */
export type ErrorCode =
	| "BAD_REQUEST"
	| "UNAUTHORIZED"
	| "FORBIDDEN"
	| "NOT_FOUND"
	| "CONFLICT"
	/** A dependency refused (an open breaker, a blown deadline) and nothing was retained. */
	| "UNAVAILABLE"
	| "INTERNAL";

export class AppError extends Error {
	readonly code: ErrorCode;

	constructor(code: ErrorCode, message: string) {
		super(message);
		this.name = "AppError";
		this.code = code;
	}
}

/**
 * Throws BAD_REQUEST on failure. Services validate their own input because protobuf only
 * guarantees field shapes (it has no idea a title must be 1-200 characters), so both
 * transports get the same rules from the same schema.
 */
export function parseInput<T extends Type>(schema: T, input: unknown): T["infer"] {
	const result = schema(input);

	if (result instanceof type.errors) {
		throw new AppError("BAD_REQUEST", result.summary);
	}

	return result as T["infer"];
}

/** Postgres: unique_violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Catch this rather than checking first: "is this email taken?" then an insert leaves a
 * gap where two concurrent signups both pass the check and one fails as a 500. Only the
 * index answers atomically.
 */
export function isUniqueViolation(error: unknown): boolean {
	return someCause(error, (code) => code === UNIQUE_VIOLATION);
}

/** Socket-level failures: nothing reached Postgres, or nothing came back. */
const CONNECTION_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"EPIPE",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
]);

/**
 * Could not talk to Postgres, as opposed to Postgres refusing the query: the line
 * firefly's `shouldRetry` (no default) makes you draw. SQLSTATE class 08 is connection
 * exception, 57P01-57P03 admin or crash shutdown, 53300 too many connections. A syntax
 * error, constraint violation or bad credentials is not retried; it only repeats the bug.
 */
export function isConnectionError(error: unknown): boolean {
	return someCause(
		error,
		(code) =>
			typeof code === "string" &&
			(CONNECTION_CODES.has(code) ||
				code.startsWith("08") ||
				/^57P0[123]$/.test(code) ||
				code === "53300"),
	);
}

/** Drizzle wraps driver errors, so the code can sit a level or two down the cause chain. */
function someCause(error: unknown, matches: (code: unknown) => boolean): boolean {
	let current: unknown = error;

	for (let depth = 0; current && depth < 5; depth++) {
		const { code, cause } = current as { code?: unknown; cause?: unknown };

		if (matches(code)) return true;

		current = cause;
	}

	return false;
}
