import { readonly, ref } from "vue";
import { trpc } from "../lib/trpc";

export type CurrentUser = Awaited<ReturnType<typeof trpc.auth.me.query>>;

// Module scope, so every component shares one session.
const user = ref<CurrentUser | null>(null);
const ready = ref(false);

/** The app never sees a token, so "am I signed in?" is asked of the server. */
async function load(): Promise<void> {
	try {
		user.value = await trpc.auth.me.query();
	} catch {
		// A 401 usually means the short-lived access token lapsed (15 minutes by default)
		// while the refresh cookie, which lasts days, is still good.
		try {
			user.value = await trpc.auth.refresh.mutate();
		} catch {
			user.value = null;
		}
	} finally {
		ready.value = true;
	}
}

export function useAuth() {
	async function login(email: string, password: string): Promise<void> {
		user.value = await trpc.auth.login.mutate({ email, password });
	}

	async function register(email: string, name: string, password: string): Promise<void> {
		user.value = await trpc.auth.register.mutate({ email, name, password });
	}

	async function logout(): Promise<void> {
		await trpc.auth.logout.mutate();
		user.value = null;
	}

	return {
		user: readonly(user),
		ready: readonly(ready),
		load,
		login,
		register,
		logout,
	};
}
