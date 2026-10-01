import { stringifySetCookie } from "cookie";
import { buildTokenCookie, clearTokenCookie } from "lacewing";
import { accessTokenSeconds, env } from "../config/env";

export const ACCESS_COOKIE = "access_token";
export const REFRESH_COOKIE = "refresh_token";
/** Not httpOnly - the double-submit CSRF check needs the page to read it. */
export const CSRF_COOKIE = "csrf_token";

/**
 * lacewing's buildTokenCookie always sets httpOnly, Secure and SameSite, so there is no
 * COOKIE_SECURE switch and an XSS bug cannot read the tokens. Browsers treat
 * http://localhost as a secure context, so Secure works in dev.
 *
 * The clear path passes the same COOKIE_DOMAIN: a cookie is identified by name, domain and
 * path together, so a logout that omits the domain expires a cookie the browser lacks.
 */
const SAME_SITE = env.COOKIE_SAME_SITE === "strict" ? "Strict" : "Lax";

export function sessionCookies(
	accessToken: string,
	refreshToken: string,
	csrfToken: string,
): string[] {
	return [
		buildTokenCookie(accessToken, {
			name: ACCESS_COOKIE,
			sameSite: SAME_SITE,
			domain: env.COOKIE_DOMAIN,
			maxAgeSeconds: accessTokenSeconds,
		}),
		buildTokenCookie(refreshToken, {
			name: REFRESH_COOKIE,
			sameSite: SAME_SITE,
			domain: env.COOKIE_DOMAIN,
			maxAgeSeconds: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
		}),
		// Built with `cookie` because lacewing cannot emit a non-httpOnly cookie.
		stringifySetCookie({
			name: CSRF_COOKIE,
			value: csrfToken,
			httpOnly: false,
			secure: true,
			sameSite: env.COOKIE_SAME_SITE,
			path: "/",
			domain: env.COOKIE_DOMAIN,
			maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
		}),
	];
}

export function clearedCookies(): string[] {
	const headers = new Headers();
	clearTokenCookie(headers, { name: ACCESS_COOKIE, domain: env.COOKIE_DOMAIN });
	clearTokenCookie(headers, { name: REFRESH_COOKIE, domain: env.COOKIE_DOMAIN });

	return [
		...headers.getSetCookie(),
		stringifySetCookie({
			name: CSRF_COOKIE,
			value: "",
			httpOnly: false,
			secure: true,
			sameSite: env.COOKIE_SAME_SITE,
			path: "/",
			domain: env.COOKIE_DOMAIN,
			maxAge: 0,
		}),
	];
}
