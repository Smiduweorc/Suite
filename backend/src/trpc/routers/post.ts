import { publicFeed } from "../../services/feed.service";
import {
	CreatePostInput,
	createPost,
	deletePost,
	getPost,
	ListPostsInput,
	listPosts,
	PostIdInput,
	UpdatePostInput,
	updatePost,
} from "../../services/post.service";
import { protectedProcedure, publicProcedure, router } from "../trpc";

/**
 * Reads are public, but what you can read depends on who you are (drafts are yours alone
 * until published). Who may touch an existing post is the service's call.
 */
export const postRouter = router({
	/**
	 * Published posts only, the same for everyone, so it is the one cached read.
	 * `cache.state` is fresh | stale | retained | miss.
	 */
	feed: publicProcedure.query(({ ctx }) => publicFeed(ctx)),

	/** Published posts plus your own drafts, newest first; nextCursor is null on the last page. */
	list: publicProcedure.input(ListPostsInput).query(({ ctx, input }) => listPosts(ctx, input)),

	byId: publicProcedure.input(PostIdInput).query(({ ctx, input }) => getPost(ctx, input)),

	/** The author comes from the token. */
	create: protectedProcedure
		.input(CreatePostInput)
		.mutation(({ ctx, input }) => createPost(ctx, input)),

	/** Yours, or you are an admin. */
	update: protectedProcedure
		.input(UpdatePostInput)
		.mutation(({ ctx, input }) => updatePost(ctx, input)),

	/** Yours, or you are an admin. */
	delete: protectedProcedure
		.input(PostIdInput)
		.mutation(({ ctx, input }) => deletePost(ctx, input)),
});
