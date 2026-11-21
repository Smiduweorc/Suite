import { Redis } from "ioredis";
import type {
	Claim,
	Completion,
	Entry as LedgerEntry,
	Store as LedgerStore,
} from "mycocepurus-smithii";
import type { Entry as CacheEntry, Store as CacheStore } from "repletes";
import type { Logger } from "../lib/logger";

/**
 * `enableOfflineQueue: false` is the important line: ioredis's default queues commands
 * while disconnected, which turns a Redis outage into requests that hang. Off, a command
 * fails at once; Repletes treats that as a miss, and a failed ledger claim becomes a 503.
 *
 * Nothing is awaited at boot, so the server (and CI's smoke test) starts with no Redis.
 */
export function createRedis(url: string, log: Logger): Redis {
	const redis = new Redis(url, {
		enableOfflineQueue: false,
		maxRetriesPerRequest: 1,
		// Back off to one attempt every five seconds rather than hammering a dead host.
		retryStrategy: (times) => Math.min(times * 200, 5_000),
	});

	// Without a listener ioredis prints "Unhandled error event" for every failed
	// reconnect. One line per transition is plenty.
	let healthy = true;
	redis.on("error", (err) => {
		if (healthy) log.warn({ err }, "redis unavailable");
		healthy = false;
	});
	redis.on("ready", () => {
		if (!healthy) log.info("redis reconnected");
		healthy = true;
	});

	return redis;
}

/**
 * `retainFor` becomes PX only as a hint for reclaiming space: Repletes re-checks every
 * window against `storedAt`, so a lingering key is never served past its window. Values
 * go through JSON, so `T` must be JSON-shaped.
 */
export class RedisCacheStore<T> implements CacheStore<T> {
	constructor(private readonly redis: Redis) {}

	async get(key: string): Promise<CacheEntry<T> | undefined> {
		const raw = await this.redis.get(key);

		return raw === null ? undefined : (JSON.parse(raw) as CacheEntry<T>);
	}

	async set(key: string, entry: CacheEntry<T>, retainFor: number): Promise<void> {
		await this.redis.set(key, JSON.stringify(entry), "PX", Math.max(1, Math.ceil(retainFor)));
	}

	async delete(key: string): Promise<void> {
		await this.redis.del(key);
	}
}

/**
 * mycocepurus-smithii rethrows a store failure unchanged; naming it lets the route answer
 * 503 rather than file it under bugs.
 */
export class LedgerUnavailableError extends Error {
	override readonly name = "LedgerUnavailableError";
}

async function guarded<T>(operation: string, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (cause) {
		throw new LedgerUnavailableError(`idempotency store failed to ${operation}`, { cause });
	}
}

/**
 * `claim` is the whole guarantee: `SET key value NX PX leaseFor`, so two replicas racing
 * on one key see exactly one "OK". A losing SET reads the winner back for the ledger to
 * decide (replay, 409 in-flight, 422 mismatch). If the winner's lease expired between the
 * two commands, nothing is held and the claim is tried again.
 */
export class RedisLedgerStore<T> implements LedgerStore<T> {
	constructor(private readonly redis: Redis) {}

	claim(key: string, entry: Claim): Promise<"claimed" | LedgerEntry<T>> {
		return guarded("claim", async () => {
			for (let attempt = 0; attempt < 3; attempt++) {
				const json = JSON.stringify(entry);
				const won = await this.redis.set(key, json, "PX", entry.leaseFor, "NX");

				if (won === "OK") return "claimed";

				const held = await this.redis.get(key);

				if (held !== null) return JSON.parse(held) as LedgerEntry<T>;
			}

			throw new Error(`claim on ${key} kept racing an expiring entry`);
		});
	}

	/**
	 * Owner-checked in one round trip: an attempt that outlived its lease must not overwrite
	 * the claim of the retry that replaced it. The claim key carries PX leaseFor, so a key
	 * that still exists is a live claim.
	 */
	complete(key: string, entry: Completion<T>, owner: string): Promise<boolean> {
		return guarded("complete", async () => {
			const done = await this.redis.eval(
				COMPLETE_IF_OWNER,
				1,
				key,
				JSON.stringify(owner),
				JSON.stringify(entry),
				Math.max(1, Math.ceil(entry.retainFor)),
			);

			return done === 1;
		});
	}

	release(key: string, owner: string): Promise<boolean> {
		return guarded("release", async () => {
			const done = await this.redis.eval(RELEASE_IF_OWNER, 1, key, JSON.stringify(owner));

			return done === 1;
		});
	}

	forget(key: string): Promise<void> {
		return guarded("forget", async () => {
			await this.redis.del(key);
		});
	}
}

/**
 * Shared prefix: proceed only if KEYS[1] holds an in-flight claim whose owner is ARGV[1]
 * (passed JSON-quoted).
 * Plain substring matches rather than cjson, which ioredis-mock lacks: the claim is written
 * by JSON.stringify above, so `"state":"in-flight"` and `"owner":"<uuid>"` appear verbatim,
 * and a complete entry has no `owner` field at all.
 */
const OWNS = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
if not string.find(raw, '"state":"in-flight"', 1, true) then return 0 end
if not string.find(raw, '"owner":' .. ARGV[1], 1, true) then return 0 end
`;

const COMPLETE_IF_OWNER = `${OWNS}
redis.call("SET", KEYS[1], ARGV[2], "PX", ARGV[3])
return 1
`;

const RELEASE_IF_OWNER = `${OWNS}
redis.call("DEL", KEYS[1])
return 1
`;
