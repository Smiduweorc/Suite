import { createHash, randomBytes } from "node:crypto";
import { env } from "../config/env";

/**
 * Opaque, not JWTs. The database stores only the SHA-256, so whoever reads the table
 * cannot use what they find. Plain SHA-256 is enough (passwords need argon2) because the
 * input is 256 bits of entropy: there is no dictionary to run against it.
 */
export function generateRefreshToken(): string {
	return randomBytes(32).toString("base64url");
}

export function hashRefreshToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** Reads env here because no service imports `env` (they take a ServiceCtx only). */
export function refreshTokenExpiresAt(now = Date.now()): Date {
	return new Date(now + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}
