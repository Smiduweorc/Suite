import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ApiClient, HttpError, TransportError } from "@suite/api-client";
import { constant, Dependency, TimeoutError } from "firefly-limiter";
import { retryableTransportError } from "firefly-limiter/http";
import { endSession } from "../session";
import { resilientFetch } from "../transport";

/**
 * Signing out through the real client and the real transport, with the network and the
 * keychain as the only fakes. `events` is the order things happened in, across both.
 */

let events: string[];
let sent: { url: string; method: string; body: string | undefined; headers: Headers }[];
let reply: (signal: AbortSignal | undefined) => Promise<Response>;
const realFetch = globalThis.fetch;

beforeEach(() => {
	events = [];
	sent = [];
	reply = async () => Response.json({ ok: true });

	globalThis.fetch = (async (url: string, init: RequestInit) => {
		events.push("revoke");
		sent.push({
			url,
			method: init.method ?? "GET",
			body: init.body as string | undefined,
			headers: new Headers(init.headers),
		});

		return reply(init.signal ?? undefined);
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

/** A clock whose every wait is already over, so a deadline fires as soon as it is set. */
const expired = { now: () => 0, sleep: () => Promise.resolve() };

function client(clock?: typeof expired): ApiClient {
	const dependency = new Dependency({
		name: "test",
		attempts: 4,
		backoff: constant(0),
		shouldRetry: retryableTransportError,
		deadline: 8_000,
		breaker: false,
		...(clock ? { clock } : {}),
	});

	return new ApiClient({ baseUrl: "http://api.test", transport: resilientFetch(dependency) });
}

const forget = async () => {
	events.push("forget");
};

describe("endSession", () => {
	it("revokes the refresh token on the server, then forgets the session on the device", async () => {
		const outcome = await endSession(client(), "r1", forget);

		expect(outcome).toEqual({ revoked: true });
		expect(events).toEqual(["revoke", "forget"]);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.url).toBe("http://api.test/api/v1/auth/logout");
		expect(sent[0]?.method).toBe("POST");
		expect(sent[0]?.body).toBe('{"refreshToken":"r1"}');
	});

	it("sends no access token with the revoke: the refresh token is the credential", async () => {
		await endSession(client(), "r1", forget);

		expect(sent[0]?.headers.get("authorization")).toBeNull();
	});

	it("still forgets the session when the server cannot be reached, and says it was not revoked", async () => {
		reply = async () => {
			throw new TypeError("Network request failed");
		};

		const outcome = await endSession(client(), "r1", forget);

		expect(outcome.revoked).toBe(false);
		expect(outcome.revoked === false && outcome.error).toBeInstanceOf(TransportError);
		expect(events).toEqual(["revoke", "forget"]);
	});

	it("sends the revoke once, without retrying it, when the network fails", async () => {
		reply = async () => {
			throw new TypeError("Network request failed");
		};

		await endSession(client(), "r1", forget);

		expect(sent).toHaveLength(1);
	});

	it("still forgets the session when the server answers with an error, and carries the status", async () => {
		reply = async () =>
			Response.json(
				{ error: "INTERNAL", message: "Internal server error", requestId: "q" },
				{ status: 500 },
			);

		const outcome = await endSession(client(), "r1", forget);

		expect(outcome.revoked).toBe(false);
		const error = outcome.revoked === false ? outcome.error : undefined;
		expect(error).toBeInstanceOf(HttpError);
		expect((error as HttpError).status).toBe(500);
		expect(sent).toHaveLength(1);
		expect(events).toEqual(["revoke", "forget"]);
	});

	it("gives up on a server that never answers at the deadline, then forgets the session", async () => {
		let aborted = false;
		reply = (signal) =>
			new Promise((_, reject) => {
				signal?.addEventListener("abort", () => {
					aborted = true;
					reject(signal.reason);
				});
			});

		const outcome = await endSession(client(expired), "r1", forget);

		expect(outcome.revoked).toBe(false);
		const error = outcome.revoked === false ? outcome.error : undefined;
		expect(error).toBeInstanceOf(TransportError);
		expect((error as TransportError).cause).toBeInstanceOf(TimeoutError);
		expect(aborted).toBe(true);
		expect(events).toEqual(["revoke", "forget"]);
	});

	it("sends nothing when there is no session, and forgets anyway", async () => {
		const outcome = await endSession(client(), undefined, forget);

		expect(outcome).toEqual({ revoked: true });
		expect(sent).toHaveLength(0);
		expect(events).toEqual(["forget"]);
	});

	it("rejects with the keychain's own error when the delete fails, after revoking", async () => {
		const refused = new Error("keychain locked");

		await expect(
			endSession(client(), "r1", async () => {
				throw refused;
			}),
		).rejects.toBe(refused);
		expect(events).toEqual(["revoke"]);
	});
});
