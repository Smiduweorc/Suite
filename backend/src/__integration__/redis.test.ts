import { afterAll, describe, expect, it } from "bun:test";
import { once } from "node:events";
import type { Redis } from "ioredis";
import { Ledger, storeAnything } from "mycocepurus-smithii";
import { Cache, fixed } from "repletes";
import { logger } from "../lib/logger";
import type { FeedPost } from "../suite";
import { createRedis, RedisCacheStore, RedisLedgerStore } from "../suite/redis";
import { integrationRedis } from "./servers";

const { redisUrl, namespace } = integrationRedis();

describe.skipIf(redisUrl === "")("on a real Redis (INTEGRATION_REDIS_URL)", () => {
	const clients: Redis[] = [];

	afterAll(() => Promise.all(clients.map((client) => client.quit())));

	/** The app's own client. It has no offline queue, so wait until it can take commands. */
	async function connect(): Promise<Redis> {
		const client = createRedis(redisUrl, logger);
		clients.push(client);

		if (client.status !== "ready") await once(client, "ready");

		return client;
	}

	it("runs the action once when 10 replicas claim one key at the same time", async () => {
		// One connection each, as ten processes would have: SET NX is what has to hold
		// across them, not anything inside one ioredis client.
		const replicas = await Promise.all(
			Array.from(
				{ length: 10 },
				async () =>
					new Ledger<string>({
						store: new RedisLedgerStore<string>(await connect()),
						namespace: `${namespace}:idem`,
						retainFor: 60_000,
						leaseFor: 30_000,
						maxKeyLength: 255,
						shouldStore: storeAnything,
					}),
			),
		);
		const request = { scope: "user-1", key: "one-key", fingerprint: "post-body" };

		// Hold whoever gets into the action until every copy has either got in too or been
		// refused, so a second winner cannot hide behind the first one finishing early.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let arrived!: () => void;
		const allArrived = new Promise<void>((resolve) => {
			arrived = resolve;
		});
		let ran = 0;
		let refused = 0;
		const tally = () => {
			if (ran + refused === replicas.length) arrived();
		};

		const runs = replicas.map((ledger) =>
			ledger
				.run(request, async () => {
					ran += 1;
					tally();
					await gate;
					return "created";
				})
				.catch((error: unknown) => {
					refused += 1;
					tally();
					throw error;
				}),
		);
		// Attached now: the refusals reject long before the gate opens.
		const outcomes = Promise.allSettled(runs);

		await allArrived;
		expect(ran).toBe(1);

		release();
		const settled = await outcomes;

		expect(settled.filter((s) => s.status === "fulfilled")).toEqual([
			{ status: "fulfilled", value: { state: "first", value: "created", age: 0 } },
		]);
		const refusals = settled.flatMap((s) => (s.status === "rejected" ? [s.reason] : []));
		expect(refusals).toHaveLength(9);
		for (const reason of refusals) expect(reason).toMatchObject({ code: "in-flight" });

		// The completion was written where every replica reads: a retry anywhere replays.
		await expect(replicas[9]?.run(request, async () => "again")).resolves.toMatchObject({
			state: "replayed",
			value: "created",
		});
		expect(ran).toBe(1);
	});

	it("round-trips a feed through Repletes, with Redis expiring it after the retention window", async () => {
		const writer = await connect();
		const reader = await connect();
		let now = Date.parse("2026-03-01T12:00:00.000Z");
		const windows = fixed({
			freshFor: 10_000,
			staleWhileRevalidate: 60_000,
			staleIfError: 600_000,
		});
		const feedOn = (client: Redis) =>
			new Cache<FeedPost[]>({
				store: new RedisCacheStore<FeedPost[]>(client),
				namespace: `${namespace}:feed`,
				freshness: windows,
				now: () => now,
			});
		const cache = feedOn(writer);
		const post: FeedPost = {
			id: "7f9c2d1e-0000-4000-8000-000000000001",
			title: "Grüße aus der Kolonie",
			body: 'line one\nline two "quoted"',
			authorId: "7f9c2d1e-0000-4000-8000-000000000002",
			createdAt: "2026-03-01T11:59:00.000Z",
			updatedAt: "2026-03-01T11:59:30.000Z",
		};
		let queries = 0;
		const query = async () => {
			queries += 1;
			return [post];
		};

		await expect(cache.read("public", query)).resolves.toMatchObject({ state: "miss" });
		// A second connection, so this is what Redis holds, not anything in the writer.
		await expect(feedOn(reader).read("public", query)).resolves.toEqual({
			state: "fresh",
			value: [post],
			age: 0,
		});
		expect(queries).toBe(1);

		// retainFor is freshFor + max(staleWhileRevalidate, staleIfError) = 610s.
		const ttl = await reader.pttl(`${namespace}:feed:public`);
		expect(ttl).toBeGreaterThan(600_000);
		expect(ttl).toBeLessThanOrEqual(610_000);

		now += 10_001;
		await expect(feedOn(reader).peek("public")).resolves.toMatchObject({
			state: "stale",
			value: [post],
		});

		await cache.forget("public");
		expect(await reader.exists(`${namespace}:feed:public`)).toBe(0);
		await expect(feedOn(reader).peek("public")).resolves.toBeUndefined();
	});
});
