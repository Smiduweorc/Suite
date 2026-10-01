import { desc, eq } from "drizzle-orm";
import { FireflyError } from "firefly-limiter";
import type { ReadState } from "repletes";
import type { Database } from "../db";
import { type Post, posts } from "../db/schema";
import { AppError, isConnectionError } from "../lib/errors";
import { FEED_KEY, FEED_SIZE, type FeedPost } from "../suite";
import type { ServiceCtx } from "./context";

export interface Feed {
	posts: FeedPost[];
	/** From Repletes' `read()`: "retained" means it survived a database outage. */
	cache: { state: ReadState; ageMs: number };
}

export function toFeedPost(post: Post): FeedPost {
	return {
		id: post.id,
		title: post.title,
		body: post.body,
		authorId: post.authorId,
		createdAt: post.createdAt.toISOString(),
		updatedAt: post.updatedAt.toISOString(),
	};
}

async function queryFeed(db: Database): Promise<FeedPost[]> {
	const rows = await db.query.posts.findMany({
		where: eq(posts.published, true),
		orderBy: desc(posts.createdAt),
		limit: FEED_SIZE,
	});

	return rows.map(toFeedPost);
}

/**
 * Identical for every caller, which is the only reason it can be cached under one key
 * (`post.list` is per-actor because of drafts).
 *
 * The nesting is drawn in suite/index.ts. `share` collapses concurrent misses, because
 * Repletes leaves single-flight to the layer that owns retries and deadlines.
 */
export async function publicFeed(ctx: ServiceCtx): Promise<Feed> {
	const { feed, postgres } = ctx.suite;

	try {
		const result = await feed.read(FEED_KEY, () =>
			postgres.run(() => queryFeed(ctx.db), { share: FEED_KEY }),
		);

		return { posts: result.value, cache: { state: result.state, ageMs: result.age } };
	} catch (error) {
		// Postgres unreachable or firefly refused (breaker, deadline), with nothing retained:
		// an outage, so 503. A query Postgres rejected stays a bug.
		if (error instanceof FireflyError || isConnectionError(error)) {
			throw new AppError("UNAVAILABLE", "The feed is temporarily unavailable");
		}

		throw error;
	}
}

/**
 * Call after a write that could change the feed; Repletes cannot see that itself. Never
 * throws: a store failure goes to onEvent and the entry ages out within `freshFor`.
 */
export function invalidateFeed(ctx: ServiceCtx): Promise<void> {
	return ctx.suite.feed.forget(FEED_KEY);
}
