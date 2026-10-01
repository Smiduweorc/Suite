import { ref } from "vue";

/**
 * The message comes from the server verbatim: the backend's `errorFormatter` (trpc/trpc.ts)
 * has already decided what a caller may be told.
 */
export function useAsync(fallback = "Something went wrong") {
	const busy = ref(false);
	const error = ref<string | null>(null);

	/** True on success, so a caller can clear a form only then. */
	async function run(action: () => Promise<void>): Promise<boolean> {
		busy.value = true;
		error.value = null;

		try {
			await action();

			return true;
		} catch (cause) {
			error.value = cause instanceof Error ? cause.message : fallback;

			return false;
		} finally {
			busy.value = false;
		}
	}

	return { busy, error, run };
}
