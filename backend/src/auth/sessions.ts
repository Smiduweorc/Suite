import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db";
import { refreshTokens } from "../db/schema";

/**
 * Takes a `Database`, not a `ServiceCtx`, so it cannot be mistaken for a transport-callable
 * entry point: nothing here checks the actor. The caller must establish the privilege
 * first (user.service.ts does, with requireAdmin, before it demotes anyone).
 */
export function revokeAllSessions(db: Database, userId: string): Promise<unknown> {
	return db
		.update(refreshTokens)
		.set({ revokedAt: new Date() })
		.where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

/** Logging out of this browser does not sign you out everywhere. */
export function revokeSession(db: Database, tokenHash: string): Promise<unknown> {
	return db
		.update(refreshTokens)
		.set({ revokedAt: new Date() })
		.where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)));
}
