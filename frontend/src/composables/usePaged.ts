import { ref, shallowRef } from "vue";
import { useAsync } from "./useAsync";

interface Page<T> {
	items: T[];
	nextCursor: string | null;
}

/**
 * Reads get their own busy flag and error, apart from the caller's mutations: a failed
 * "Load more" must not read as a failed delete.
 *
 * The cursor is whatever the server last handed back, never derived from `items`, which
 * the caller edits as it creates and deletes.
 *
 * `items` is a shallowRef: every change replaces the array, so deep reactivity would only
 * cost a proxy per row.
 */
export function usePaged<T>(
	fetchPage: (from: { cursor?: string }) => Promise<Page<T>>,
	fallback: string,
) {
	const { busy: loading, error: loadError, run } = useAsync(fallback);

	const items = shallowRef<T[]>([]);
	const nextCursor = ref<string | null>(null);

	const load = () =>
		run(async () => {
			const page = await fetchPage({});

			items.value = page.items;
			nextCursor.value = page.nextCursor;
		});

	// On failure nothing changes, so the same button retries the same page.
	const loadMore = () =>
		run(async () => {
			const cursor = nextCursor.value;

			if (cursor === null) return;

			const page = await fetchPage({ cursor });

			items.value = [...items.value, ...page.items];
			nextCursor.value = page.nextCursor;
		});

	return { items, nextCursor, loading, loadError, load, loadMore };
}
