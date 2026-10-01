import { type ApiClient, logout } from "@suite/api-client";

/**
 * The server's copy of the session; the device's is gone either way. No session to begin
 * with counts as revoked.
 */
export type SignOut = { revoked: true } | { revoked: false; error: unknown };

/**
 * The device always forgets: an unreachable server is no reason to keep someone signed
 * in. The cost goes back to the caller to show: an unrevoked refresh token stays valid
 * until it expires. Nothing is kept to revoke later, because a refresh token kept on the
 * phone is a session kept on the phone.
 *
 * Revoke first, forget second. The other order, interrupted, leaves a live token on the
 * server that nobody holds and nobody can revoke.
 *
 * Sent once: the transport repeats a POST only with an Idempotency-Key, and someone
 * waiting on a button is better served by one attempt than four with backoff.
 *
 * Apart from api.ts so it can be tested without expo's native modules.
 */
export async function endSession(
	client: ApiClient,
	refreshToken: string | undefined,
	forget: () => Promise<void>,
): Promise<SignOut> {
	let outcome: SignOut = { revoked: true };

	if (refreshToken !== undefined) {
		try {
			await client.request(logout({ refreshToken }));
		} catch (error) {
			outcome = { revoked: false, error };
		}
	}

	await forget();

	return outcome;
}
