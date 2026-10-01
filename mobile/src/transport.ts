import type { Transport } from "@suite/api-client";
import { Dependency, exponential, timeout } from "firefly-limiter";
import {
	idempotentMethods,
	RetryableResponseError,
	retryableStatuses,
	retryableTransportError,
} from "firefly-limiter/http";

/** Module scope on purpose: a breaker per screen would measure nothing. */
export const backend = new Dependency({
	name: "suite-api",
	// Mobile networks drop requests. Four tries with backoff rides out a tunnel.
	attempts: 4,
	backoff: exponential({ base: 300, max: 4_000 }),
	// Network failures, deadlines and RetryableResponseError (below) - never a 4xx.
	shouldRetry: retryableTransportError,
	deadline: 8_000,
	// Five straight failed attempts (the breaker counts each retry, not each call) and the
	// app stops trying for 20s instead of draining the battery against a dead server.
	breaker: { threshold: 5, resetAfter: 20_000 },
});

/**
 * When on, the first response to every write is lost after the server processed it, so
 * firefly retries with the same Idempotency-Key and the server replays the first response.
 */
export const simulation = { dropFirstWriteResponse: false };

/**
 * Not firefly's own `transport()`: it replays a body by reading `request.body` as a
 * stream, and React Native's Request (the whatwg-fetch polyfill) has no `body` stream and
 * its copy constructor marks the original as used, so every retry of a POST fails with
 * "Already read". Here the text is read once and a fresh Request built per attempt.
 */
export function resilientFetch(dependency: Dependency): Transport {
	return async (request) => {
		const body =
			request.method === "GET" || request.method === "HEAD"
				? undefined
				: await request.text();
		const keyed = request.headers.has("idempotency-key");

		// A POST without a key is sent exactly once: repeating it could create a duplicate.
		// With a key, the server holds the client to "same key, same request" - and a 409
		// means the first copy is still running, so waiting and asking again is correct.
		const mayRetry = idempotentMethods.includes(request.method) || keyed;
		const statuses = keyed ? [...retryableStatuses, 409] : retryableStatuses;

		let dropped = !(simulation.dropFirstWriteResponse && body !== undefined);

		const attempt = async (signal: AbortSignal): Promise<Response> => {
			const response = await fetch(request.url, {
				method: request.method,
				headers: request.headers,
				body,
				signal,
			});

			if (!dropped) {
				dropped = true;
				// The server already did the work. We just never heard back.
				throw new TypeError("Network request failed (simulated: response lost)");
			}

			if (statuses.includes(response.status)) throw new RetryableResponseError(response);

			return response;
		};

		try {
			if (mayRetry) return await dependency.run(attempt);

			// React Native's fetch has no deadline of its own, so without this a login on a
			// dead network waits for as long as the OS keeps the socket open.
			const { deadline, clock } = dependency.options;

			return await timeout(deadline, { clock })(attempt)(request.signal);
		} catch (error) {
			// Out of attempts on a retryable status: that response is the answer.
			if (error instanceof RetryableResponseError) return error.response;

			throw error;
		}
	};
}
