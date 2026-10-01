import { ref } from "vue";
import { trpc } from "../lib/trpc";

/** Here rather than in App.vue because only composables import `lib/trpc`. */
export function useHealth() {
	const status = ref("checking...");

	async function check(): Promise<void> {
		try {
			const { status: ok } = await trpc.health.ping.query();

			status.value = ok;
		} catch {
			status.value = "unreachable - is the backend running?";
		}
	}

	return { status, check };
}
