import { hash, verify } from "@node-rs/argon2";

/**
 * argon2id via a native module that hashes on a background thread. A hash computed in
 * JavaScript blocks Bun's one thread, and with it every request. Measured here:
 *
 *   bcryptjs (cost 12): 8 concurrent logins -> a trivial /ping took 1364ms
 *   argon2id (here):    8 concurrent logins -> the same /ping took 0-4ms
 *
 * bcryptjs's "async" API only slices the work with setImmediate on the main thread, which
 * makes login a DoS lever, worse because `login()` hashes even for an unknown email.
 *
 * Defaults are @node-rs/argon2's, the OWASP recommendation (m=19456 KiB, t=2, p=1); ~250ms
 * is the usual target. The parameters are encoded in the hash, so changing them does not
 * invalidate existing hashes.
 */
export function hashPassword(password: string): Promise<string> {
	return hash(password);
}

export async function verifyPassword(password: string, digest: string): Promise<boolean> {
	try {
		return await verify(digest, password);
	} catch {
		// A malformed or truncated hash in the database: not a match, not a crash.
		return false;
	}
}
