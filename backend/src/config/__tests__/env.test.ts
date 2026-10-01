import { afterEach, describe, expect, it } from "bun:test";

/**
 * config/env.ts validates once, at import, so each case imports a fresh copy (a new query
 * string is a new module to Bun) under a different environment. test/preload.ts supplies a
 * complete, valid one; each case knocks out or replaces one variable.
 */
const original = { ...process.env };
let copies = 0;

function freshEnv(): Promise<typeof import("../env")> {
	return import(`../env?copy=${++copies}`);
}

function stubEnv(overrides: Record<string, string | undefined>): void {
	for (const [name, value] of Object.entries(overrides)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

async function bootWith(overrides: Record<string, string | undefined>): Promise<unknown> {
	stubEnv(overrides);

	return (await freshEnv()).env;
}

afterEach(() => {
	for (const name of Object.keys(process.env)) {
		if (!(name in original)) delete process.env[name];
	}
	Object.assign(process.env, original);
});

describe("environment", () => {
	it("boots on the complete environment the tests run with", async () => {
		await expect(bootWith({})).resolves.toMatchObject({
			JWT_ISSUER: "http://localhost:3000",
			JWT_ACCESS_EXPIRY: "15m",
		});
	});

	// Who to trust, where to reach, and how long a session lives: a missing one is a
	// deployment mistake, and falling back to a localhost value hides it until a token
	// from the wrong issuer verifies or the CORS origin lets in the wrong site.
	it.each([
		"DATABASE_URL",
		"REDIS_URL",
		"CORS_ORIGIN",
		"JWT_SECRET",
		"JWT_ISSUER",
		"JWT_AUDIENCE",
		"JWT_ACCESS_EXPIRY",
		"REFRESH_TOKEN_TTL_DAYS",
	])("refuses to boot without %s", async (name) => {
		await expect(bootWith({ [name]: undefined })).rejects.toThrow(name);
	});

	it.each([
		["1s", 1],
		["15m", 900],
		["1h", 3600],
		["3600s", 3600],
		["60m", 3600],
	])("accepts the access-token lifetime %s as %i seconds", async (expiry, seconds) => {
		stubEnv({ JWT_ACCESS_EXPIRY: expiry });

		await expect(freshEnv()).resolves.toMatchObject({ accessTokenSeconds: seconds });
	});

	// Anything lacewing would refuse to sign with, refused at boot rather than as a 500
	// on the first login: its syntax is digits and one of s, m, h, d, and it caps access
	// tokens at an hour.
	it.each([
		"15 minutes",
		"1.5h",
		"-15m",
		"m",
		"900",
		"900ms",
		"1w",
		" 15m",
		"0s",
		"3601s",
		"2h",
		"1d",
	])("refuses to boot on the access-token lifetime %j", async (expiry) => {
		await expect(bootWith({ JWT_ACCESS_EXPIRY: expiry })).rejects.toThrow("JWT_ACCESS_EXPIRY");
	});
});
