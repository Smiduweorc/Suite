import { ref } from "vue";
import { trpc } from "../lib/trpc";
import { useAsync } from "./useAsync";

export type Feed = Awaited<ReturnType<typeof trpc.post.feed.query>>;

export function useFeed() {
	const { busy, error, run } = useAsync("Could not load the feed");

	const feed = ref<Feed | null>(null);

	const load = () =>
		run(async () => {
			feed.value = await trpc.post.feed.query();
		});

	return { feed, busy, error, load };
}
