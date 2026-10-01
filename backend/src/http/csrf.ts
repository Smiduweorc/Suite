import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Stateless double-submit CSRF. A cross-site page can make the browser send our cookies
 * but cannot read them, so a value that arrives both as a cookie and as a header the page
 * had to read the cookie to set proves the request came from our origin.
 *
 * Minted with each session (auth router) into CSRF_COOKIE. SameSite is the first line of
 * defence; this covers the browsers and subdomain corners SameSite does not.
 */
export function generateCsrfToken(): string {
	return randomBytes(32).toString("base64url");
}

export function csrfTokensMatch(cookie: string | undefined, header: string | undefined): boolean {
	if (!cookie || !header) return false;

	const a = Buffer.from(cookie);
	const b = Buffer.from(header);

	// The length is not the secret.
	if (a.length !== b.length) return false;

	return timingSafeEqual(a, b);
}
