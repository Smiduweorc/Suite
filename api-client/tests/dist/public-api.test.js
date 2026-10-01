// Consumes the build output the way the mobile app does, so the entry point, the emitted
// specifiers and the published surface all get exercised. `bun run test` builds first.

import assert from "node:assert/strict";
import { test } from "node:test";

import * as pkg from "../../dist/index.js";

// Update this list by hand: a name added or removed here is a change to the package's API.
const publicSurface = [
	"ApiClient",
	"ApiError",
	"DecodeError",
	"HttpError",
	"TransportError",
	"deepObject",
	"joined",
	"readJson",
];

// The generator rewrites the block below and prints what it added or removed.
// dung-beetle:start generated public surface
const generatedSurface = [
	"createPost",
	"getFeed",
	"login",
	"logout",
	"refreshSession",
];
// dung-beetle:end

test("the built entry point exports exactly the intended surface", () => {
	assert.deepEqual(Object.keys(pkg).sort(), [...publicSurface, ...generatedSurface].sort());
});

test("a generated operation goes through the transport it was given", async () => {
	let seen;
	const client = new pkg.ApiClient({
		baseUrl: "https://api.test",
		transport: async (request) => {
			seen = request;
			return Response.json({ posts: [], cache: { state: "miss", ageMs: 0 } });
		},
	});

	const feed = await client.request(pkg.getFeed());

	assert.equal(seen.method, "GET");
	assert.equal(new URL(seen.url).pathname, "/api/v1/feed");
	assert.deepEqual(feed.cache, { state: "miss", ageMs: 0 });
});

test("a refusal from the API arrives as an HttpError carrying the body", async () => {
	const client = new pkg.ApiClient({
		baseUrl: "https://api.test",
		transport: async () => Response.json({ error: "fingerprint-mismatch" }, { status: 422 }),
	});

	const error = await client
		.request(pkg.createPost({ title: "t", body: "b" }), {
			headers: { "idempotency-key": '"k"' },
		})
		.then(
			() => undefined,
			(caught) => caught,
		);

	assert.ok(error instanceof pkg.HttpError);
	assert.equal(error.status, 422);
	assert.match(error.body, /fingerprint-mismatch/);
});

test("logout posts the refresh token as JSON and resolves with the server's ok", async () => {
	let seen;
	let sentBody;
	const client = new pkg.ApiClient({
		baseUrl: "https://api.test",
		transport: async (request) => {
			seen = request;
			sentBody = await request.text();
			return Response.json({ ok: true });
		},
	});

	const result = await client.request(pkg.logout({ refreshToken: "r1" }));

	assert.equal(seen.method, "POST");
	assert.equal(new URL(seen.url).pathname, "/api/v1/auth/logout");
	assert.equal(seen.headers.get("content-type"), "application/json");
	assert.equal(seen.headers.get("authorization"), null);
	assert.deepEqual(JSON.parse(sentBody), { refreshToken: "r1" });
	assert.deepEqual(result, { ok: true });
});
