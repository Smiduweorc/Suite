import type { Actor } from "../auth/policy";
import type { Database } from "../db";
import { logger } from "../lib/logger";
import type { ServiceCtx } from "../services/context";
import { createMemorySuite, type Suite } from "../suite";
import type { ActorSource } from "../trpc/context";
import { appRouter } from "../trpc/routers";
import { createCallerFactory } from "../trpc/trpc";

const createCaller = createCallerFactory(appRouter);

interface CallerOptions {
	actor?: Actor | null;
	/** Defaults to "direct", which the CSRF guard ignores (app.test.ts covers CSRF over
	 * HTTP). Pass "cookie" plus csrf values to exercise the guard here. */
	actorSource?: ActorSource | null;
	refreshToken?: string;
	csrf?: { cookie?: string; header?: string };
	/** Pass one to share a cache between callers. */
	suite?: Suite;
}

/**
 * The response headers are how the auth tests read back the cookies the router set. The
 * real logger is passed through (LOG_LEVEL is `silent` in test/preload.ts) so the logging
 * middleware still runs.
 */
export function callerWithHeaders(
	db: Database,
	{
		actor = null,
		actorSource,
		refreshToken,
		csrf,
		suite = createMemorySuite(logger),
	}: CallerOptions = {},
) {
	const resHeaders = new Headers();

	const trpc = createCaller({
		db,
		suite,
		actor,
		actorSource: actorSource !== undefined ? actorSource : actor ? "direct" : null,
		resHeaders,
		refreshToken,
		csrf: { cookie: csrf?.cookie, header: csrf?.header },
		req: new Request("http://localhost/trpc"),
		requestId: "test-request-id",
		log: logger,
	});

	return { trpc, resHeaders };
}

export function callerAs(db: Database, actor: Actor | null, suite?: Suite) {
	return callerWithHeaders(db, { actor, suite }).trpc;
}

/** For testing a service without a transport in the way. */
export function serviceCtx(
	db: Database,
	actor: Actor | null = null,
	suite: Suite = createMemorySuite(logger),
): ServiceCtx {
	return { db, log: logger, actor, suite };
}
