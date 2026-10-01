import { canMutate } from "@bevd/backend/policy";
import { trpc } from "../lib/trpc";
import { useAsync } from "./useAsync";
import { useAuth } from "./useAuth";
import { usePaged } from "./usePaged";

export type Post = Awaited<ReturnType<typeof trpc.post.list.query>>["items"][number];

/**
 * State is per-caller, unlike useAuth: App.vue keys PostsPanel on the user, so remounting
 * starts a clean list. `posts` is writable rather than readonly(): the ref is created per
 * call and never escapes this module. Reads report through `loading` and `loadError`;
 * writes through `busy` and `error`.
 */
export function usePosts() {
	const { user } = useAuth();
	const { busy, error, run } = useAsync();

	// Signed-in callers also see their own drafts, so reloading after sign-in shows them.
	const {
		items: posts,
		nextCursor,
		loading,
		loadError,
		load,
		loadMore,
	} = usePaged((from) => trpc.post.list.query(from), "Could not load posts");

	/** Only decides which buttons to draw; the server's own canMutate call decides. */
	function canEdit(post: Post): boolean {
		const current = user.value;

		return current ? canMutate(current, post.authorId) : false;
	}

	const create = (title: string, body: string) =>
		run(async () => {
			const post = await trpc.post.create.mutate({ title, body });

			posts.value = [post, ...posts.value];
		});

	const togglePublished = (post: Post) =>
		run(async () => {
			const updated = await trpc.post.update.mutate({
				id: post.id,
				published: !post.published,
			});

			posts.value = posts.value.map((p) => (p.id === updated.id ? updated : p));
		});

	const remove = (post: Post) =>
		run(async () => {
			await trpc.post.delete.mutate({ id: post.id });

			posts.value = posts.value.filter((p) => p.id !== post.id);
		});

	return {
		posts,
		nextCursor,
		loading,
		loadError,
		busy,
		error,
		canEdit,
		load,
		loadMore,
		create,
		togglePublished,
		remove,
	};
}
