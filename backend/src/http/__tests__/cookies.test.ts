import { afterEach, describe, expect, it } from "bun:test";
import { env } from "../../config/env";
import { clearedCookies, sessionCookies } from "../cookies";

/**
 * COOKIE_DOMAIN has to reach every session cookie, the CSRF one included, and logout has
 * to name the same domain (see http/cookies.ts). config/env.ts reads the environment once,
 * at import, so each case evaluates a fresh copy of it (a new query string is a new module
 * to Bun) and gives the shared `env` that copy's COOKIE_DOMAIN. http/cookies.ts reads it
 * per call.
 */
let copies = 0;

async function cookiesWith(domain: string): Promise<{
	set: string[];
	cleared: string[];
}> {
	process.env.COOKIE_DOMAIN = domain;

	const fresh: typeof import("../../config/env") = await import(
		`../../config/env?copy=${++copies}`
	);
	setDomain(fresh.env.COOKIE_DOMAIN);

	return {
		set: sessionCookies("accesstoken", "refreshtoken", "csrftoken"),
		cleared: clearedCookies(),
	};
}

function setDomain(domain: string | undefined): void {
	if (domain === undefined) delete env.COOKIE_DOMAIN;
	else env.COOKIE_DOMAIN = domain;
}

afterEach(() => {
	delete process.env.COOKIE_DOMAIN;
	setDomain(undefined);
});

describe("cookie scope", () => {
	it("leaves every cookie host-only when COOKIE_DOMAIN is unset", async () => {
		const { set, cleared } = await cookiesWith("");

		expect(set).toHaveLength(3);
		expect(cleared).toHaveLength(3);
		for (const cookie of [...set, ...cleared]) {
			expect(cookie).not.toContain("Domain=");
		}
	});

	it("scopes the token and CSRF cookies to COOKIE_DOMAIN together", async () => {
		const { set, cleared } = await cookiesWith("example.com");

		expect(set).toHaveLength(3);
		expect(cleared).toHaveLength(3);
		for (const cookie of [...set, ...cleared]) {
			expect(cookie).toContain("Domain=example.com");
		}
	});

	it("treats a leading dot as the same domain, per RFC 6265", async () => {
		const { set } = await cookiesWith(".example.com");

		for (const cookie of set) {
			expect(cookie).toContain("Domain=example.com");
		}
	});
});
