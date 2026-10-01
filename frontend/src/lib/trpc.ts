import type { AppRouter } from "@bevd/backend/trpc";
import { createTRPCClient, httpBatchLink, type TRPCClient } from "@trpc/client";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

/**
 * The page's half of double-submit CSRF (backend/src/http/csrf.ts). With the app and the
 * API on different hosts and no COOKIE_DOMAIN set, this returns undefined every time and
 * every mutation fails CSRF.
 */
function csrfToken(): string | undefined {
	return document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)?.[1];
}

/**
 * The explicit `TRPCClient<AppRouter>` annotation is required: without it TypeScript
 * infers a type it cannot name from inside this package and fails with TS2742.
 */
export const trpc: TRPCClient<AppRouter> = createTRPCClient<AppRouter>({
	links: [
		httpBatchLink({
			url: `${API_URL}/trpc`,
			// Makes the browser attach the httpOnly token cookies.
			fetch: (url, options) => fetch(url, { ...options, credentials: "include" }),
			headers: () => {
				const token = csrfToken();

				return token ? { "x-csrf-token": token } : {};
			},
		}),
	],
});
