import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { constant, Dependency, retryAnything, TimeoutError } from "firefly-limiter";
import { retryableTransportError } from "firefly-limiter/http";
import { resilientFetch, simulation } from "../transport";

/**
 * The one piece of resilience logic the app wrote itself (see transport.ts for why it
 * exists). firefly decides; these tests pin that the decisions reach the wire: what is
 * retried, what is sent once, and that every attempt carries the same body and key.
 */

interface Seen {
	method: string;
	body: string | undefined;
	key: string | null;
}

let seen: Seen[];
let replies: (() => Response)[];
const realFetch = globalThis.fetch;

beforeEach(() => {
	seen = [];
	replies = [];
	simulation.dropFirstWriteResponse = false;

	globalThis.fetch = (async (url: string, init: RequestInit) => {
		const headers = new Headers(init.headers);
		seen.push({
			method: init.method ?? "GET",
			body: init.body as string | undefined,
			key: headers.get("idempotency-key"),
		});

		const next = replies.shift();
		if (!next) throw new TypeError(`Network request failed: ${url}`);

		return next();
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

function dependency(): Dependency {
	return new Dependency({
		name: "test",
		attempts: 3,
		backoff: constant(0),
		shouldRetry: retryableTransportError,
		deadline: 1_000,
		breaker: false,
	});
}

const ok = () => Response.json({ ok: true }, { status: 201 });

function post(headers: Record<string, string> = {}): Request {
	return new Request("http://api.test/api/v1/posts", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ title: "t", body: "b" }),
	});
}

describe("resilientFetch", () => {
	it("retries a keyed POST with the same body and the same key", async () => {
		replies = [() => Response.json({}, { status: 503 }), ok];

		const response = await resilientFetch(dependency())(post({ "idempotency-key": '"k1"' }));

		expect(response.status).toBe(201);
		expect(seen).toHaveLength(2);
		expect(seen[0]).toEqual(seen[1] as Seen);
		expect(seen[1]?.key).toBe('"k1"');
		expect(seen[1]?.body).toBe('{"title":"t","body":"b"}');
	});

	it("sends a POST without a key exactly once, even when it fails", async () => {
		await expect(resilientFetch(dependency())(post())).rejects.toThrow(
			"Network request failed",
		);

		expect(seen).toHaveLength(1);
	});

	it("waits out a 409 in-flight only when the request is keyed", async () => {
		replies = [() => Response.json({}, { status: 409 }), ok];
		const keyed = await resilientFetch(dependency())(post({ "idempotency-key": '"k2"' }));
		expect(keyed.status).toBe(201);

		replies = [() => Response.json({}, { status: 409 }), ok];
		const get = await resilientFetch(dependency())(new Request("http://api.test/api/v1/feed"));
		expect(get.status).toBe(409); // a GET's 409 is an answer, not a busy server
	});

	it("hands back the last retryable response once attempts run out", async () => {
		replies = [503, 503, 503].map((status) => () => Response.json({}, { status }));

		const response = await resilientFetch(dependency())(new Request("http://api.test/x"));

		expect(response.status).toBe(503);
		expect(seen).toHaveLength(3);
	});

	it("simulates a lost response: the server is hit twice with one key", async () => {
		simulation.dropFirstWriteResponse = true;
		replies = [ok, ok];

		const response = await resilientFetch(dependency())(post({ "idempotency-key": '"k3"' }));

		expect(response.status).toBe(201);
		expect(seen.map((s) => s.key)).toEqual(['"k3"', '"k3"']);
	});

	it("never retries a 4xx the server meant", async () => {
		replies = [() => Response.json({ error: "fingerprint-mismatch" }, { status: 422 })];

		const response = await resilientFetch(
			new Dependency({
				name: "t",
				attempts: 3,
				backoff: constant(0),
				shouldRetry: retryAnything,
				deadline: 1_000,
				breaker: false,
			}),
		)(post({ "idempotency-key": '"k4"' }));

		expect(response.status).toBe(422);
		expect(seen).toHaveLength(1);
	});
});

describe("resilientFetch, sending once", () => {
	it("abandons a POST without a key at the dependency's deadline, having sent it once", async () => {
		let aborted = false;
		globalThis.fetch = ((_url: string, init: RequestInit) => {
			seen.push({ method: init.method ?? "GET", body: init.body as string, key: null });

			return new Promise((_, reject) => {
				init.signal?.addEventListener("abort", () => {
					aborted = true;
					reject(init.signal?.reason);
				});
			});
		}) as typeof fetch;

		const dependency = new Dependency({
			name: "t",
			attempts: 3,
			backoff: constant(0),
			shouldRetry: retryableTransportError,
			deadline: 8_000,
			breaker: false,
			// Every wait is already over, so the deadline fires as soon as it is set.
			clock: { now: () => 0, sleep: () => Promise.resolve() },
		});

		// Not `expect(...).rejects`: bun spins on a promise that never settles, so the
		// test's own timeout could not fire if the deadline did not.
		const outcome = await resilientFetch(dependency)(post()).then(
			() => "answered",
			(error: unknown) => error,
		);

		expect(outcome).toBeInstanceOf(TimeoutError);
		expect(aborted).toBe(true);
		expect(seen).toHaveLength(1);
	});
});
