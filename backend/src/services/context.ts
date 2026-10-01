import type { Actor } from "../auth/policy";
import type { Database } from "../db";
import type { Logger } from "../lib/logger";
import type { Suite } from "../suite";

/**
 * Everything a service is allowed to know about the call. Every service function is
 * `fn(ctx, input)`, so adding a dependency is not a signature change through both
 * transports and every test.
 *
 * No Request, headers, cookies or gRPC metadata: the actor is the only thing a service
 * learns about the caller, resolved at the edge from a cookie (trpc/context.ts) or from
 * metadata (grpc/metadata.ts). Both transports' contexts are supersets, so they pass
 * themselves straight in.
 */
export interface ServiceCtx {
	db: Database;
	log: Logger;
	/** Null for an anonymous caller. The service decides whether that is acceptable. */
	actor: Actor | null;
	/** Redis-backed in production, in-memory in tests (suite/index.ts). */
	suite: Suite;
}
