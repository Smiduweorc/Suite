import { beforeEach, describe, expect, it } from "bun:test";
import type { Redis } from "ioredis";
import { createApp } from "../app";
import { createDatabase, type Database } from "../db";
import type { PublicUser } from "../db/schema";
import { logger } from "../lib/logger";
import { publicFeed } from "../services/feed.service";
import { createMemorySuite, createSuite, type Suite } from "../suite";
import { RedisCacheStore, RedisLedgerStore } from "../suite/redis";
import { accessTokenFor, actorFor, seedUser } from "../test/auth";
import { callerAs, serviceCtx } from "../test/context";
import { createTestDatabase } from "../test/db";

/**
 * The Smiduweorc libraries, exercised through the app rather than on their own - each
 * library has its own suite for that. What is pinned here is the wiring: that the policy
 * in suite/index.ts reaches the transports, and that the libraries compose the way the
 * comments claim.
 */

describe("phasmid: one mailbox, one account", () => {
	let db: Database;

	beforeEach(async () => {
		db = await createTestDatabase();
	});

	it("refuses to register an alias of a taken Gmail address", async () => {
		const anon = callerAs(db, null);

		await anon.auth.register({
			email: "john.doe@gmail.com",
			name: "John",
			password: "password123",
		});

		// Dots, a +tag and the googlemail alias: all the same inbox.
		await expect(
			anon.auth.register({
				email: "JohnDoe+second@googlemail.com",
				name: "Also John",
				password: "password123",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("signs in with any alias, and keeps the address as typed", async () => {
		const anon = callerAs(db, null);

		await anon.auth.register({
			email: "jane.doe@gmail.com",
			name: "Jane",
			password: "password123",
		});

		const user = await anon.auth.login({
			email: "janedoe+mobile@gmail.com",
			password: "password123",
		});

		expect(user.email).toBe("jane.doe@gmail.com");
	});

	it("does not merge +tags on a domain it does not know", async () => {
		const anon = callerAs(db, null);

		await anon.auth.register({ email: "a@example.com", name: "A", password: "password123" });

		// Could be a different mailbox - phasmid is conservative, and so is this app.
		await expect(
			anon.auth.register({ email: "a+b@example.com", name: "B", password: "password123" }),
		).resolves.toMatchObject({ email: "a+b@example.com" });

		// ...but case is still folded, as it always was here.
		await expect(
			anon.auth.register({ email: "A@Example.com", name: "C", password: "password123" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});

describe("Repletes + firefly: the public feed", () => {
	let db: Database;
	let alice: PublicUser;
	let clock: number;
	let suite: Suite;

	beforeEach(async () => {
		db = await createTestDatabase();
		alice = await seedUser(db, { email: "alice@example.com", name: "Alice" });
		clock = 1_000_000;
		suite = createMemorySuite(logger, { now: () => clock });
	});

	it("misses once, then serves fresh, then stale while revalidating", async () => {
		await callerAs(db, actorFor(alice), suite).post.create({
			title: "Hello",
			body: "x",
			published: true,
		});

		const ctx = serviceCtx(db, null, suite);

		expect((await publicFeed(ctx)).cache.state).toBe("miss");
		expect((await publicFeed(ctx)).cache.state).toBe("fresh");

		clock += 15_000; // past freshFor (10s), inside staleWhileRevalidate
		const stale = await publicFeed(ctx);
		expect(stale.cache).toMatchObject({ state: "stale", ageMs: 15_000 });
		expect(stale.posts.map((p) => p.title)).toEqual(["Hello"]);

		await suite.feed.settled(); // the background refresh landed...
		expect((await publicFeed(ctx)).cache.state).toBe("fresh"); // ...and replaced it
	});

	it("only ever shows published posts", async () => {
		const asAlice = callerAs(db, actorFor(alice), suite);
		await asAlice.post.create({ title: "Draft", body: "x" });
		await asAlice.post.create({ title: "Public", body: "x", published: true });

		const feed = await publicFeed(serviceCtx(db, actorFor(alice), suite));

		expect(feed.posts.map((p) => p.title)).toEqual(["Public"]);
	});

	it("forgets the cached feed when a published post is written", async () => {
		const asAlice = callerAs(db, actorFor(alice), suite);
		const ctx = serviceCtx(db, null, suite);

		await publicFeed(ctx); // cache the empty feed
		await asAlice.post.create({ title: "New", body: "x", published: true });

		const feed = await publicFeed(ctx);

		expect(feed.cache.state).toBe("miss");
		expect(feed.posts.map((p) => p.title)).toEqual(["New"]);
	});

	it("serves the retained feed when the database is down, and says so", async () => {
		await callerAs(db, actorFor(alice), suite).post.create({
			title: "Survivor",
			body: "x",
			published: true,
		});
		await publicFeed(serviceCtx(db, null, suite));

		clock += 5 * 60_000; // past stale-while-revalidate, inside stale-if-error

		// Nothing listens here: firefly retries once, gives up, and Repletes steps in.
		const { db: down } = createDatabase("postgres://nobody:x@127.0.0.1:59999/nope");
		const feed = await publicFeed(serviceCtx(down, null, suite));

		expect(feed.cache.state).toBe("retained");
		expect(feed.posts.map((p) => p.title)).toEqual(["Survivor"]);
	});

	it("is UNAVAILABLE, not a 500, when Postgres is unreachable and nothing is retained", async () => {
		const { db: down } = createDatabase("postgres://nobody:x@127.0.0.1:59999/nope");

		await expect(publicFeed(serviceCtx(down, null, suite))).rejects.toMatchObject({
			code: "UNAVAILABLE",
		});
		// Both attempts reached for Postgres - a connection error is worth a second try -
		// and the breaker, which sits inside the retry, counted each of them.
		expect(suite.postgres.health().failures).toBe(2);
	});

	it("is UNAVAILABLE once the breaker is open and nothing is retained", async () => {
		const { db: down } = createDatabase("postgres://nobody:x@127.0.0.1:59999/nope");
		const ctx = serviceCtx(down, null, suite);

		// Five failed attempts open the breaker (threshold: 5; each call makes two)...
		for (let i = 0; i < 5; i++) {
			await publicFeed(ctx).catch(() => undefined);
		}

		expect(suite.postgres.health().circuit).toBe("open");
		// ...after which the call is refused without touching Postgres at all.
		await expect(publicFeed(ctx)).rejects.toMatchObject({ code: "UNAVAILABLE" });
	});
});

describe("mycocepurus-smithii: POST /api/v1/posts, exactly once", () => {
	let db: Database;
	let app: ReturnType<typeof createApp>;
	let token: string;

	beforeEach(async () => {
		db = await createTestDatabase();
		app = createApp({ db, log: logger, suite: createMemorySuite(logger) });
		token = await accessTokenFor(db, await seedUser(db, { email: "bob@example.com" }));
	});

	function create(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
		return app.handle(
			new Request("http://localhost/api/v1/posts", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
					...headers,
				},
				body: JSON.stringify(body),
			}),
		);
	}

	async function feedTitles(): Promise<string[]> {
		const response = await app.handle(new Request("http://localhost/api/v1/feed"));
		const feed = (await response.json()) as { posts: { title: string }[] };

		return feed.posts.map((p) => p.title);
	}

	it("runs once and replays the first response to every retry", async () => {
		const post = { title: "Flaky network", body: "sent twice", published: true };
		const key = { "idempotency-key": '"key-1"' };

		const first = await create(post, key);
		const retry = await create(post, key);

		expect(first.status).toBe(201);
		expect(first.headers.get("idempotent-replayed")).toBe("false");
		expect(retry.status).toBe(201);
		expect(retry.headers.get("idempotent-replayed")).toBe("true");
		// Byte for byte: the same id, not a second post.
		expect(await retry.json()).toEqual(await first.json());
		expect(await feedTitles()).toEqual(["Flaky network"]);
	});

	it("treats a new key as a new request", async () => {
		const post = { title: "Twice on purpose", body: "x", published: true };

		await create(post, { "idempotency-key": '"a"' });
		await create(post, { "idempotency-key": '"b"' });

		expect(await feedTitles()).toHaveLength(2);
	});

	it("refuses a reused key with a different body (422)", async () => {
		await create({ title: "One", body: "x" }, { "idempotency-key": '"same"' });
		const reused = await create({ title: "Two", body: "x" }, { "idempotency-key": '"same"' });

		expect(reused.status).toBe(422);
		await expect(reused.json()).resolves.toMatchObject({ error: "fingerprint-mismatch" });
	});

	it("refuses a missing or unquoted key (400)", async () => {
		const missing = await create({ title: "x", body: "x" });
		const bare = await create({ title: "x", body: "x" }, { "idempotency-key": "bare-token" });

		expect(missing.status).toBe(400);
		await expect(missing.json()).resolves.toMatchObject({ error: "missing-key" });
		expect(bare.status).toBe(400);
		await expect(bare.json()).resolves.toMatchObject({ error: "invalid-key" });
	});

	it("replays a validation failure as the same failure", async () => {
		const invalid = { title: "", body: "x" };

		const first = await create(invalid, { "idempotency-key": '"bad"' });
		const retry = await create(invalid, { "idempotency-key": '"bad"' });

		expect(first.status).toBe(400);
		expect(retry.status).toBe(400);
		expect(retry.headers.get("idempotent-replayed")).toBe("true");
	});

	it("needs a bearer token before it will look at the key", async () => {
		const response = await app.handle(
			new Request("http://localhost/api/v1/posts", {
				method: "POST",
				headers: { "content-type": "application/json", "idempotency-key": '"k"' },
				body: JSON.stringify({ title: "x", body: "x" }),
			}),
		);

		expect(response.status).toBe(401);
	});
});

describe("REST v1 over http", () => {
	let app: ReturnType<typeof createApp>;

	beforeEach(async () => {
		const db = await createTestDatabase();
		await seedUser(db, { email: "jane.doe@gmail.com", password: "password123" });
		app = createApp({ db, log: logger, suite: createMemorySuite(logger) });
	});

	it("logs in by any alias and returns bearer tokens in the body", async () => {
		const response = await app.handle(
			new Request("http://localhost/api/v1/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					email: "JaneDoe+phone@googlemail.com",
					password: "password123",
				}),
			}),
		);

		expect(response.status).toBe(200);
		// No cookies on this door: bearer only.
		expect(response.headers.getSetCookie()).toEqual([]);
		await expect(response.json()).resolves.toMatchObject({
			user: { email: "jane.doe@gmail.com" },
			accessToken: expect.any(String),
			refreshToken: expect.any(String),
		});
	});

	it("reports the cache state in a header and in the body", async () => {
		const first = await app.handle(new Request("http://localhost/api/v1/feed"));
		const second = await app.handle(new Request("http://localhost/api/v1/feed"));

		expect(first.headers.get("x-cache")).toBe("miss");
		expect(second.headers.get("x-cache")).toBe("fresh");
		await expect(second.json()).resolves.toMatchObject({ cache: { state: "fresh" } });
	});

	it("describes /api/v1 in the OpenAPI document the client is generated from", async () => {
		const response = await app.handle(new Request("http://localhost/openapi/json"));
		const spec = (await response.json()) as { paths: Record<string, unknown> };

		expect(Object.keys(spec.paths)).toEqual(
			expect.arrayContaining([
				"/api/v1/auth/login",
				"/api/v1/auth/refresh",
				"/api/v1/auth/logout",
				"/api/v1/feed",
				"/api/v1/posts",
			]),
		);
	});

	it("exposes firefly's view of Postgres on /health", async () => {
		const response = await app.handle(new Request("http://localhost/health"));

		await expect(response.json()).resolves.toMatchObject({
			dependencies: [{ name: "postgres", circuit: "closed" }],
		});
	});
});

describe("REST v1: signing out", () => {
	let app: ReturnType<typeof createApp>;

	beforeEach(async () => {
		const db = await createTestDatabase();
		await seedUser(db, { email: "bob@example.com", password: "password123" });
		app = createApp({ db, log: logger, suite: createMemorySuite(logger) });
	});

	function post(path: string, body?: unknown, headers: Record<string, string> = {}) {
		return app.handle(
			new Request(`http://localhost/api/v1${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
	}

	async function signIn(): Promise<{ accessToken: string; refreshToken: string }> {
		const response = await post("/auth/login", {
			email: "bob@example.com",
			password: "password123",
		});

		return (await response.json()) as { accessToken: string; refreshToken: string };
	}

	const logout = (refreshToken: string, headers?: Record<string, string>) =>
		post("/auth/logout", { refreshToken }, headers);
	const refresh = (refreshToken: string) => post("/auth/refresh", { refreshToken });

	it("revokes the refresh token on its own say-so, with no access token sent", async () => {
		const { refreshToken } = await signIn();

		const response = await logout(refreshToken);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true });

		const after = await refresh(refreshToken);
		expect(after.status).toBe(401);
		await expect(after.json()).resolves.toMatchObject({
			error: "UNAUTHORIZED",
			message: "Invalid or expired refresh token",
			requestId: expect.any(String),
		});
	});

	it("answers a second logout with the same token exactly like the first", async () => {
		const { refreshToken } = await signIn();

		const first = await logout(refreshToken);
		const second = await logout(refreshToken);

		expect(second.status).toBe(200);
		await expect(second.json()).resolves.toEqual(await first.json());
	});

	it("answers two concurrent logouts with the same token with 200 each", async () => {
		const { refreshToken } = await signIn();

		const both = await Promise.all([logout(refreshToken), logout(refreshToken)]);

		expect(both.map((r) => r.status)).toEqual([200, 200]);
		expect((await refresh(refreshToken)).status).toBe(401);
	});

	it("answers 200 to a token it never issued, and ends no other session", async () => {
		const { refreshToken } = await signIn();

		const response = await logout("not-a-token-this-server-issued");

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true });
		expect((await refresh(refreshToken)).status).toBe(200);
	});

	it("answers 200 to an empty token, and ends no session", async () => {
		const { refreshToken } = await signIn();

		expect((await logout("")).status).toBe(200);
		expect((await refresh(refreshToken)).status).toBe(200);
	});

	it("answers 200 to a token a refresh already rotated away, and leaves its successor alive", async () => {
		const { refreshToken: rotatedAway } = await signIn();
		const renewed = (await (await refresh(rotatedAway)).json()) as { refreshToken: string };

		expect((await logout(rotatedAway)).status).toBe(200);
		expect((await refresh(renewed.refreshToken)).status).toBe(200);
	});

	it("ends only the session it is given: the same user's other device stays signed in", async () => {
		const phone = await signIn();
		const tablet = await signIn();

		await logout(phone.refreshToken);

		expect((await refresh(phone.refreshToken)).status).toBe(401);
		expect((await refresh(tablet.refreshToken)).status).toBe(200);
	});

	it("ignores an access token that no longer verifies, rather than refusing the logout", async () => {
		const { refreshToken } = await signIn();

		const response = await logout(refreshToken, { authorization: "Bearer expired.or.forged" });

		expect(response.status).toBe(200);
		expect((await refresh(refreshToken)).status).toBe(401);
	});

	it("refuses a request with no body and ends no session", async () => {
		const { refreshToken } = await signIn();

		const response = await post("/auth/logout");

		expect(response.status).toBe(422);
		expect((await refresh(refreshToken)).status).toBe(200);
	});

	it("refuses a body without a refresh token and ends no session", async () => {
		const { refreshToken } = await signIn();

		expect((await post("/auth/logout", {})).status).toBe(422);
		expect((await post("/auth/logout", { refreshToken: 7 })).status).toBe(422);
		expect((await refresh(refreshToken)).status).toBe(200);
	});

	it("sets no cookies: the bearer door stays cookie-free", async () => {
		const { refreshToken } = await signIn();

		const response = await logout(refreshToken);

		expect(response.headers.getSetCookie()).toEqual([]);
	});

	it("is described in OpenAPI without a security requirement", async () => {
		const response = await app.handle(new Request("http://localhost/openapi/json"));
		const spec = (await response.json()) as {
			paths: Record<
				string,
				{ post?: { security?: unknown; requestBody?: unknown; responses?: object } }
			>;
		};
		const operation = spec.paths["/api/v1/auth/logout"]?.post;

		expect(operation).toBeDefined();
		expect(operation?.security).toBeUndefined();
		expect(Object.keys(operation?.responses ?? {}).sort()).toEqual(["200", "400", "422"]);
		expect(operation?.requestBody).toMatchObject({
			content: {
				"application/json": {
					schema: { required: ["refreshToken"] },
				},
			},
		});
	});
});

describe("when Redis is down", () => {
	/** What ioredis does with enableOfflineQueue off and no connection: reject at once. */
	const offline = new Proxy({} as Redis, {
		get: () => () => Promise.reject(new Error("Stream isn't writeable")),
	});

	let app: ReturnType<typeof createApp>;
	let token: string;

	beforeEach(async () => {
		const db = await createTestDatabase();
		const suite = createSuite(
			{ cache: new RedisCacheStore(offline), ledger: new RedisLedgerStore(offline) },
			logger,
		);
		app = createApp({ db, log: logger, suite });
		token = await accessTokenFor(db, await seedUser(db));
	});

	it("still serves the feed: Repletes reports the store error and treats it as a miss", async () => {
		const response = await app.handle(new Request("http://localhost/api/v1/feed"));

		expect(response.status).toBe(200);
		expect(response.headers.get("x-cache")).toBe("miss");
	});

	it("refuses idempotent writes with 503 rather than performing them unguarded", async () => {
		const response = await app.handle(
			new Request("http://localhost/api/v1/posts", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
					"idempotency-key": '"k"',
				},
				body: JSON.stringify({ title: "x", body: "x" }),
			}),
		);

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({ error: "UNAVAILABLE" });
	});
});
