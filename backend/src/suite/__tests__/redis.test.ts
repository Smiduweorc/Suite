import { beforeEach, describe, expect, it } from "bun:test";
import type { Redis } from "ioredis";
import RedisMock from "ioredis-mock";
import { Ledger, storeAnything } from "mycocepurus-smithii";
import { Cache, fixed } from "repletes";
import { RedisCacheStore, RedisLedgerStore } from "../redis";

/**
 * The two Redis adapters, driven through the real library classes - so what is tested is
 * that each one honours its library's Store contract, not that it calls SET. ioredis-mock
 * implements NX and PX in memory, which is the part the contracts lean on.
 */
function redis(): Redis {
	return new RedisMock() as unknown as Redis;
}

describe("RedisLedgerStore", () => {
	let client: Redis;
	let ledger: Ledger<string>;

	beforeEach(async () => {
		client = redis();
		await client.flushall();
		ledger = new Ledger<string>({
			store: new RedisLedgerStore(client),
			retainFor: 60_000,
			leaseFor: 5_000,
			maxKeyLength: 255,
			shouldStore: storeAnything,
		});
	});

	const request = { scope: "user-1", key: "k", fingerprint: "f" };

	it("runs the action once and replays it after", async () => {
		let runs = 0;
		const action = async () => `run ${++runs}`;

		const first = await ledger.run(request, action);
		const second = await ledger.run(request, action);

		expect(first).toMatchObject({ state: "first", value: "run 1" });
		expect(second).toMatchObject({ state: "replayed", value: "run 1" });
		expect(runs).toBe(1);
	});

	it("lets exactly one of two concurrent copies through", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const slow = ledger.run(request, async () => {
			await gate;
			return "first";
		});
		// The claim is SET NX: the second copy finds the first's in-flight entry.
		await expect(ledger.run(request, async () => "second")).rejects.toMatchObject({
			code: "in-flight",
		});

		release();
		await expect(slow).resolves.toMatchObject({ value: "first" });
	});

	it("keeps scopes apart", async () => {
		await ledger.run(request, async () => "mine");
		const theirs = await ledger.run({ ...request, scope: "user-2" }, async () => "theirs");

		expect(theirs).toMatchObject({ state: "first", value: "theirs" });
	});

	it("releases the key when the action throws, so a retry runs", async () => {
		await expect(
			ledger.run(request, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		await expect(ledger.run(request, async () => "retried")).resolves.toMatchObject({
			state: "first",
		});
	});

	it("sets a TTL on what it writes, as a hint for reclaiming space", async () => {
		await ledger.run(request, async () => "x");

		const [key] = await client.keys("*");
		expect(await client.pttl(key ?? "")).toBeGreaterThan(0);
	});
});

describe("RedisCacheStore", () => {
	it("round-trips an entry through JSON and serves it fresh", async () => {
		const client = redis();
		await client.flushall();
		let now = 0;
		const cache = new Cache<{ n: number }[]>({
			store: new RedisCacheStore(client),
			freshness: fixed({ freshFor: 1_000, staleWhileRevalidate: 0, staleIfError: 0 }),
			namespace: "t",
			now: () => now,
		});

		let calls = 0;
		const action = async () => [{ n: ++calls }];

		expect(await cache.read("k", action)).toMatchObject({ state: "miss", value: [{ n: 1 }] });
		expect(await cache.read("k", action)).toMatchObject({ state: "fresh", value: [{ n: 1 }] });

		now += 2_000;
		expect(await cache.read("k", action)).toMatchObject({ state: "miss", value: [{ n: 2 }] });

		await cache.forget("k");
		expect(await cache.peek("k")).toBeUndefined();
	});
});
