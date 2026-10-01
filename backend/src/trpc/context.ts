import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { parseBearer, readTokenCookie } from "lacewing";
import { verifyAccessToken } from "../auth/jwt";
import type { Actor } from "../auth/policy";
import type { Database } from "../db";
import { ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE } from "../http/cookies";
import type { Logger } from "../lib/logger";
import type { ServiceCtx } from "../services/context";
import type { Suite } from "../suite";

/**
 * Matters only for CSRF: cookie-authenticated mutations need the check (trpc.ts). "direct"
 * is for tests that hand an actor straight to the caller.
 */
export type ActorSource = "cookie" | "bearer" | "direct";

export interface Context extends ServiceCtx {
	req: Request;
	resHeaders: Headers;
	actorSource: ActorSource | null;
	/** Only auth.refresh and auth.logout look at this. */
	refreshToken: string | undefined;
	/** The two halves of the double-submit pair; trpc.ts compares them. */
	csrf: { cookie: string | undefined; header: string | undefined };
	/** Shared with the access log and returned to the client on an error. */
	requestId: string;
}

export interface ContextDeps {
	db: Database;
	suite: Suite;
	requestId: string;
	log: Logger;
}

/**
 * The httpOnly cookie for the browser, falling back to a bearer header (strict RFC 6750
 * via parseBearer) for curl, other services and the mobile app. A bad or expired token
 * means anonymous; turning that into a 401 is the procedure's job.
 */
async function resolveActor(
	db: Database,
	req: Request,
): Promise<{ actor: Actor | null; source: ActorSource | null }> {
	let token = readTokenCookie(req, ACCESS_COOKIE);
	let source: ActorSource = "cookie";

	if (!token && req.headers.get("authorization") !== null) {
		try {
			token = parseBearer(req);
			source = "bearer";
		} catch {
			// A malformed Authorization header is anonymous, same as a bad token.
			return { actor: null, source: null };
		}
	}

	if (!token) return { actor: null, source: null };

	try {
		const payload = await verifyAccessToken(db, token);

		return {
			actor: { id: payload.sub, email: payload.email, role: payload.role },
			source,
		};
	} catch {
		return { actor: null, source: null };
	}
}

export function createContextFactory({ db, suite, requestId, log }: ContextDeps) {
	return async ({ req, resHeaders }: FetchCreateContextFnOptions): Promise<Context> => {
		const { actor, source } = await resolveActor(db, req);

		return {
			db,
			suite,
			req,
			resHeaders,
			actor,
			actorSource: source,
			// readTokenCookie rather than a general cookie parser, for duplicate names.
			// Nothing settles whether the first or last `csrf_token=` wins, so an attacker
			// who can write a cookie on this domain (a subdomain, a cookie-injection bug)
			// adds a second one they know, echoes it in the header and passes the
			// double-submit check. readTokenCookie refuses the ambiguous name, so the
			// mutation is denied (the legitimate user too, while the extra cookie exists).
			refreshToken: readTokenCookie(req, REFRESH_COOKIE),
			csrf: {
				cookie: readTokenCookie(req, CSRF_COOKIE),
				header: req.headers.get("x-csrf-token") ?? undefined,
			},
			requestId,
			// The user id, not the email: logs get shipped, indexed and kept.
			log: actor ? log.child({ userId: actor.id, role: actor.role }) : log,
		};
	};
}
