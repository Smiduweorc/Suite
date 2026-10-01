import { initTRPC, TRPCError } from "@trpc/server";
import { csrfTokensMatch } from "../http/csrf";
import { AppError, type ErrorCode } from "../lib/errors";
import type { Context } from "./context";

const TRPC_CODE: Record<ErrorCode, TRPCError["code"]> = {
	BAD_REQUEST: "BAD_REQUEST",
	UNAUTHORIZED: "UNAUTHORIZED",
	FORBIDDEN: "FORBIDDEN",
	NOT_FOUND: "NOT_FOUND",
	CONFLICT: "CONFLICT",
	UNAVAILABLE: "SERVICE_UNAVAILABLE",
	INTERNAL: "INTERNAL_SERVER_ERROR",
};

const t = initTRPC.context<Context>().create({
	/**
	 * tRPC passes a thrown error's message straight through, so an unhandled Postgres
	 * error would reach an anonymous caller as the failing SQL, its parameters and a stack.
	 * The real error is logged against the requestId returned here.
	 */
	errorFormatter({ shape, error, ctx }) {
		const isInternal = error.code === "INTERNAL_SERVER_ERROR";
		const { stack: _stack, ...data } = shape.data as typeof shape.data & { stack?: string };

		return {
			...shape,
			message: isInternal ? "Internal server error" : shape.message,
			data: { ...data, requestId: ctx?.requestId },
		};
	},
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;

/**
 * One log line per call, and AppError to a tRPC code (unmapped, tRPC reports it as a 500).
 * An AppError is the system working, so info; anything else is a bug, so error with stack.
 */
const observe = t.middleware(async ({ ctx, next, path, type }) => {
	const startedAt = performance.now();
	const result = await next();
	const durationMs = Math.round(performance.now() - startedAt);

	if (result.ok) {
		ctx.log.info({ procedure: path, type, durationMs }, "trpc ok");

		return result;
	}

	const { error } = result;
	const cause = error.cause;

	if (cause instanceof AppError) {
		ctx.log.info({ procedure: path, type, durationMs, code: cause.code }, "trpc rejected");

		throw new TRPCError({ code: TRPC_CODE[cause.code], message: cause.message, cause });
	}

	if (error.code === "INTERNAL_SERVER_ERROR") {
		ctx.log.error({ procedure: path, type, durationMs, err: cause ?? error }, "trpc failed");
	} else {
		// Input that failed validation lands here, as do the guards below: expected, and
		// not worth a stack.
		ctx.log.info({ procedure: path, type, durationMs, code: error.code }, "trpc rejected");
	}

	return result;
});

/**
 * Double-submit CSRF (http/csrf.ts) on cookie-authenticated mutations only. Bearer calls
 * are exempt: the caller could read the token, which a cross-site page cannot. Anonymous
 * mutations like login have no session to ride, and SameSite keeps them same-origin.
 */
const csrfGuard = t.middleware(({ ctx, type, next }) => {
	if (
		type === "mutation" &&
		ctx.actorSource === "cookie" &&
		!csrfTokensMatch(ctx.csrf.cookie, ctx.csrf.header)
	) {
		ctx.log.warn({ event: "csrf.denied" }, "mutation refused: bad or missing CSRF token");

		throw new TRPCError({ code: "FORBIDDEN", message: "CSRF token missing or invalid" });
	}

	return next();
});

/** Anonymous callers welcome. `ctx.actor` may be null. */
export const publicProcedure = t.procedure.use(observe).use(csrfGuard);

/** Narrows `ctx.actor` to `Actor`. */
export const protectedProcedure = publicProcedure.use(({ ctx, next }) => {
	if (!ctx.actor) {
		throw new TRPCError({ code: "UNAUTHORIZED", message: "You must be signed in" });
	}

	return next({ ctx: { ...ctx, actor: ctx.actor } });
});

/**
 * A fast rejection, not the security boundary: services enforce the same rule
 * (auth/actor.ts) because a gRPC call never passes through here.
 */
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
	if (ctx.actor.role !== "admin") {
		ctx.log.warn({ event: "authz.denied" }, "admin procedure refused");

		throw new TRPCError({ code: "FORBIDDEN", message: "Admins only" });
	}

	return next({ ctx });
});
