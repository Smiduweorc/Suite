import { and, eq, gt, isNull } from "drizzle-orm";
import {
	accessTokenProfile,
	importKey,
	JWTError,
	jwtVerify,
	newAccessToken,
	type RevocationStore,
} from "lacewing";
import { env } from "../config/env";
import type { Database } from "../db";
import { refreshTokens, type UserRole, userRole } from "../db/schema";
import { AppError } from "../lib/errors";

/**
 * lacewing enforces the algorithm allowlist, issuer and audience pinning, `typ: at+jwt`
 * (RFC 9068), a unique `jti`, and an entropy check that refuses a human-chosen JWT_SECRET.
 * Refresh tokens are not JWTs (tokens.ts).
 */
type Key = Awaited<ReturnType<typeof importKey>>;
type Profile = ReturnType<typeof accessTokenProfile>;

let key: Promise<Key> | undefined;

/** One profile per database, because its revocation store queries that database. */
const profiles = new WeakMap<Database, Promise<Profile>>();

/**
 * Imported on first use: a top-level `await importKey(...)` would run key derivation and
 * the entropy check for anything that merely imports a router, and a test that never
 * signs a token would still need a real secret. Concurrent callers share the cached
 * promise. `env` itself is still validated eagerly: a missing DATABASE_URL should stop the
 * process at boot, not on the first query.
 */
function loadKey(): Promise<Key> {
	key ??= importKey(env.JWT_SECRET, "HS256");

	return key;
}

function loadProfile(db: Database): Promise<Profile> {
	let profile = profiles.get(db);

	if (!profile) {
		profile = loadKey().then((keys) =>
			accessTokenProfile({
				issuer: env.JWT_ISSUER,
				audience: env.JWT_AUDIENCE,
				algorithms: ["HS256"],
				keys,
				maxTokenAge: env.JWT_ACCESS_EXPIRY,
				revocation: sessionRevocation(db),
			}),
		);
		profiles.set(db, profile);
	}

	return profile;
}

/**
 * An access token lives as long as the sign-in it came from: its `sid` must name a session
 * that still has an unrevoked, unexpired refresh token for the same user. Logout, a role
 * change (revokeAllSessions) and refresh-token expiry all end it at once instead of after
 * JWT_ACCESS_EXPIRY. Rotation does not: it revokes one row and inserts the next with the
 * same session id in one transaction, so the session is never without a live row.
 *
 * A token with no `sid` counts as revoked. lacewing consults this only after the signature
 * and claims pass, and treats a throw (database down) as revoked too: an outage makes
 * every caller anonymous rather than letting an ended session back in.
 */
function sessionRevocation(db: Database): RevocationStore {
	return {
		async isRevoked({ sid, sub }) {
			if (sid === undefined || sub === undefined) return true;

			const [live] = await db
				.select({ id: refreshTokens.id })
				.from(refreshTokens)
				.where(
					and(
						eq(refreshTokens.sessionId, sid),
						eq(refreshTokens.userId, sub),
						isNull(refreshTokens.revokedAt),
						gt(refreshTokens.expiresAt, new Date()),
					),
				)
				.limit(1);

			return live === undefined;
		},
	};
}

export interface AccessTokenPayload {
	/** The user id. `sub` is the registered JWT claim for it. */
	sub: string;
	email: string;
	role: UserRole;
	/** The session (refresh_tokens.session_id) this token dies with. */
	sid: string;
}

export async function signAccessToken(payload: AccessTokenPayload): Promise<string> {
	return newAccessToken()
		.issuer(env.JWT_ISSUER)
		.audience(env.JWT_AUDIENCE)
		.subject(payload.sub)
		.claim("email", payload.email)
		.claim("role", payload.role)
		.claim("sid", payload.sid)
		.expiresIn(env.JWT_ACCESS_EXPIRY)
		.sign(await loadKey());
}

/**
 * Throws UNAUTHORIZED on anything suspect. jwtVerify is lacewing's only verification path:
 * `alg: none` is unrepresentable and an HMAC/RSA swap fails the allowlist. One message for
 * every failure, so the caller gets no oracle for why a token was rejected.
 */
export async function verifyAccessToken(db: Database, token: string): Promise<AccessTokenPayload> {
	try {
		const { payload } = await jwtVerify(token, await loadProfile(db));

		const { sub, email, role, sid } = payload;

		if (
			typeof sub !== "string" ||
			typeof email !== "string" ||
			!isUserRole(role) ||
			typeof sid !== "string"
		) {
			throw new AppError("UNAUTHORIZED", "Malformed access token");
		}

		return { sub, email, role, sid };
	} catch (error) {
		if (error instanceof AppError) throw error;
		if (error instanceof JWTError) {
			throw new AppError("UNAUTHORIZED", "Invalid or expired access token");
		}

		throw error;
	}
}

function isUserRole(value: unknown): value is UserRole {
	return (userRole.enumValues as readonly unknown[]).includes(value);
}
