import { Dependency, exponential, TimeoutError } from "firefly-limiter";
import {
	Ledger,
	MemoryStore as LedgerMemoryStore,
	type Store as LedgerStore,
	storeAnything,
} from "mycocepurus-smithii";
import { Cache, MemoryStore as CacheMemoryStore, type Store as CacheStore, fixed } from "repletes";
import { isConnectionError } from "../lib/errors";
import type { Logger } from "../lib/logger";

/**
 * Every number below is a decision: none of these libraries ship a default, because
 * freshness, retry horizons and deadlines are properties of this app's data and traffic.
 *
 * Who owns what, top to bottom on a feed read:
 *
 *   Repletes (feed)       Do I need to compute this again? fresh -> serve; stale ->
 *                          serve and refresh behind; retained -> serve only if the
 *                          query below failed.
 *     firefly (postgres)  What do I do about a failure? deadline, one retry, and a
 *                          breaker that stops hammering a database that is down.
 *       the query
 *
 * The cache sits outside the resilience layer (Repletes' own advice), so a hit never
 * counts against the breaker. On a write from the mobile app:
 *
 *   mycocepurus (idempotency)  Has this request already happened? One execution per
 *                               Idempotency-Key, exact replay for every retry.
 */
export interface Suite {
	feed: Cache<FeedPost[]>;
	/** Around every Postgres read the feed makes. */
	postgres: Dependency;
	/** For POST /api/v1/posts. */
	idempotency: Ledger<IdempotentResult>;
}

/** What the feed caches. JSON-shaped (ISO strings, not Dates) because Redis holds JSON. */
export interface FeedPost {
	id: string;
	title: string;
	body: string;
	authorId: string;
	createdAt: string;
	updatedAt: string;
}

/** What the ledger replays: the status and JSON body the first execution produced. */
export interface IdempotentResult {
	status: number;
	body: unknown;
}

/** The one key the public feed lives under. Writes forget it; see post.service.ts. */
export const FEED_KEY = "public";

/** How many posts the public feed holds. Fixed, so the cache has exactly one key. */
export const FEED_SIZE = 50;

export interface SuiteStores {
	cache: CacheStore<FeedPost[]>;
	ledger: LedgerStore<IdempotentResult>;
}

export interface SuiteOptions {
	/** The cache's and the ledger's clock. Both libraries take one; tests move it. */
	now?: () => number;
}

export function createSuite(stores: SuiteStores, log: Logger, { now }: SuiteOptions = {}): Suite {
	const feed = new Cache<FeedPost[]>({
		store: stores.cache,
		now,
		namespace: "feed",
		// Bump to orphan every entry written in an older shape.
		version: 1,
		freshness: fixed({
			// A new post shows up within 10s even without the explicit forget() on write.
			freshFor: 10_000,
			// For a minute after that, readers get the old feed instantly while one
			// background refresh runs. No reader ever waits on a stale key.
			staleWhileRevalidate: 60_000,
			// For ten minutes, a feed survives a failing database. The response says so:
			// `cache.state` is "retained", not "fresh".
			staleIfError: 600_000,
		}),
		onEvent: (event) => {
			if (event.type === "action-error" || event.type === "store-error") {
				log.warn({ cache: "feed", ...event }, "cache degraded");
			} else {
				log.debug({ cache: "feed", ...event }, "cache");
			}
		},
	});

	const postgres = new Dependency({
		name: "postgres",
		// One retry: a connection dropped mid-query deserves a second chance, a database
		// that is down does not deserve a third.
		attempts: 2,
		backoff: exponential({ base: 50, max: 500 }),
		// Every call through here is a read, so repeating one is safe - but only worth it
		// when the database was unreachable or slow. A failing query fails the same way
		// twice. (See isConnectionError for where that line is drawn.)
		shouldRetry: (error) => error instanceof TimeoutError || isConnectionError(error),
		deadline: 2_000,
		// Five consecutive failed attempts and the breaker opens for 15s. It sits inside the
		// retry, so it counts attempts, not calls: three failing reads are enough. While
		// open, calls fail instantly with CircuitOpenError - and Repletes serves what it
		// retained.
		breaker: { threshold: 5, resetAfter: 15_000 },
		onEvent: (event) => log.warn({ dependency: "postgres", ...event }, "dependency event"),
	});

	const idempotency = new Ledger<IdempotentResult>({
		store: stores.ledger,
		namespace: "idem:posts",
		now,
		// The mobile client's retry horizon. A retry a day later is a new request.
		retainFor: 24 * 60 * 60 * 1000,
		// Longer than the slowest insert, or a slow first attempt and its retry both run.
		leaseFor: 30_000,
		// A UUID is 36. 255 is the draft's suggestion and plenty for any client.
		maxKeyLength: 255,
		// Replay failures too (a 400 stays a 400). Stripe's answer, and the draft's.
		shouldStore: storeAnything,
		onEvent: (event) => {
			if (event.type === "store-error") {
				log.warn({ ledger: "posts", ...event }, "idempotency store failed");
			} else {
				log.debug({ ledger: "posts", ...event }, "idempotency");
			}
		},
	});

	return { feed, postgres, idempotency };
}

/** For tests, and a single process with no Redis. */
export function createMemorySuite(log: Logger, options: SuiteOptions = {}): Suite {
	return createSuite(
		{
			cache: new CacheMemoryStore<FeedPost[]>({ maxEntries: 100, now: options.now }),
			ledger: new LedgerMemoryStore<IdempotentResult>({
				maxEntries: 10_000,
				now: options.now,
			}),
		},
		log,
		options,
	);
}
