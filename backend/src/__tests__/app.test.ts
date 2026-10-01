import { beforeEach, describe, expect, it } from "bun:test";
import { createApp } from "../app";
import { createDatabase, type Database } from "../db";
import { ACCESS_COOKIE, CSRF_COOKIE } from "../http/cookies";
import { logger } from "../lib/logger";
import { createMemorySuite } from "../suite";
import { createTestDatabase } from "../test/db";

/** The full HTTP path through Elysia with `app.handle()`; no port is bound. */
describe("app over http", () => {
	let app: ReturnType<typeof createApp>;
	let db: Database;

	beforeEach(async () => {
		db = await createTestDatabase();
		app = createApp({ db, log: logger, suite: createMemorySuite(logger) });
	});

	function trpc(
		procedure: string,
		body?: unknown,
		cookie?: string,
		csrfHeader?: string,
	): Promise<Response> {
		const headers: Record<string, string> = { "content-type": "application/json" };

		if (cookie) headers.cookie = cookie;
		if (csrfHeader) headers["x-csrf-token"] = csrfHeader;

		return app.handle(
			new Request(`http://localhost/trpc/${procedure}`, {
				method: body === undefined ? "GET" : "POST",
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
		);
	}

	interface BrowserSession {
		/** What a browser would send back on the next request. */
		cookie: string;
		/** What the page reads from the csrf_token cookie and echoes as a header. */
		csrfToken: string;
	}

	async function registerAlice(): Promise<BrowserSession> {
		const response = await trpc("auth.register", {
			email: "alice@example.com",
			name: "Alice",
			password: "password123",
		});

		expect(response.status).toBe(200);

		const setCookies = response.headers.getSetCookie();
		const pairs = setCookies.map((cookie) => cookie.split(";")[0] ?? "");

		expect(pairs.some((pair) => pair.startsWith(`${ACCESS_COOKIE}=`))).toBe(true);

		const csrfToken =
			pairs
				.find((pair) => pair.startsWith(`${CSRF_COOKIE}=`))
				?.slice(CSRF_COOKIE.length + 1) ?? "";

		expect(csrfToken).not.toBe("");

		return { cookie: pairs.join("; "), csrfToken };
	}

	it("serves the REST health route", async () => {
		const response = await app.handle(new Request("http://localhost/health"));

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ status: "ok" });
	});

	it("serves a tRPC query over HTTP", async () => {
		const response = await trpc("health.ping");

		expect(response.status).toBe(200);

		const body = (await response.json()) as { result: { data: { status: string } } };
		expect(body.result.data.status).toBe("ok");
	});

	it("rejects a protected mutation with no cookie", async () => {
		// This is also the mutation that proves Elysia handed tRPC an intact request body
		// rather than consuming it - a 401 means it parsed, a 500 would mean it did not.
		const response = await trpc("post.create", { title: "Nope", body: "x" });

		expect(response.status).toBe(401);

		const body = (await response.json()) as { error: { data: { code: string } } };
		expect(body.error.data.code).toBe("UNAUTHORIZED");
	});

	it("authenticates the next request with the cookie it just set", async () => {
		const session = await registerAlice();

		const created = await trpc(
			"post.create",
			{ title: "With cookie", body: "x" },
			session.cookie,
			session.csrfToken,
		);
		expect(created.status).toBe(200);

		const body = (await created.json()) as { result: { data: { title: string } } };
		expect(body.result.data.title).toBe("With cookie");
	});

	it("refuses a cookie-authenticated mutation without the CSRF header", async () => {
		// This is the cross-site request: the browser attached the cookies on
		// its own, but the page could not read csrf_token to set the header.
		const session = await registerAlice();

		const response = await trpc(
			"post.create",
			{ title: "Riding the session", body: "x" },
			session.cookie,
		);

		expect(response.status).toBe(403);

		const body = (await response.json()) as { error: { data: { code: string } } };
		expect(body.error.data.code).toBe("FORBIDDEN");
	});

	it("refuses a mutation when a second csrf_token cookie shadows the real one", async () => {
		// Cookie tossing (see trpc/context.ts). The attacker's copy is sent first on
		// purpose: browsers order cookies by path specificity, so one set on /trpc
		// precedes the legitimate /-scoped one, and a first-match parser (which
		// `cookie` is) hands back exactly the value the attacker planted.
		const session = await registerAlice();
		const attackerToken = "attackerchosencsrfvalue";

		const response = await trpc(
			"post.create",
			{ title: "Tossed", body: "x" },
			`${CSRF_COOKIE}=${attackerToken}; ${session.cookie}`,
			attackerToken,
		);

		expect(response.status).toBe(403);

		const body = (await response.json()) as { error: { data: { code: string } } };
		expect(body.error.data.code).toBe("FORBIDDEN");
	});

	it("refuses a tampered cookie", async () => {
		const session = await registerAlice();

		// Corrupt the access token specifically; the other cookies come along
		// unchanged, as they would in a real browser.
		const tampered = session.cookie.replace(
			new RegExp(`${ACCESS_COOKIE}=([^;]+)`),
			(_, token: string) => `${ACCESS_COOKIE}=${token.slice(0, -3)}aaa`,
		);

		const response = await trpc(
			"post.create",
			{ title: "Nope", body: "x" },
			tampered,
			session.csrfToken,
		);

		expect(response.status).toBe(401);
	});

	it("echoes an inbound x-request-id, so a trace survives the hop", async () => {
		const response = await app.handle(
			new Request("http://localhost/trpc/health.ping", {
				headers: { "x-request-id": "from-the-gateway" },
			}),
		);

		expect(response.headers.get("x-request-id")).toBe("from-the-gateway");
	});

	it("never leaks internals when a query blows up", async () => {
		// A database that is not there. The driver throws a real error deep inside a
		// procedure, which is exactly the case that used to hand the client the failing
		// SQL, its parameters and a stack trace.
		const { db: missing } = createDatabase("postgres://nobody:hunter2@127.0.0.1:59999/nope");
		const broken = createApp({ suite: createMemorySuite(logger), db: missing, log: logger });

		const response = await broken.handle(
			new Request("http://localhost/trpc/auth.login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ email: "alice@example.com", password: "password123" }),
			}),
		);

		expect(response.status).toBe(500);

		const raw = await response.text();
		const body = JSON.parse(raw) as {
			error: { message: string; data: { code: string; requestId?: string; stack?: string } };
		};

		expect(body.error.data.code).toBe("INTERNAL_SERVER_ERROR");
		expect(body.error.message).toBe("Internal server error");

		// Nothing about the query, the connection, the credentials, or where it broke.
		expect(body.error.data.stack).toBeUndefined();
		expect(raw).not.toMatch(/select|insert into|password|hunter2|59999|\.ts:\d+/i);

		// But the caller does get an id they can quote, which ties to the full server log.
		expect(body.error.data.requestId).toEqual(expect.any(String));
	});

	it("never leaks internals when a REST query blows up", async () => {
		// Elysia's default answer to an unexpected error is its message, verbatim, and a
		// failed Drizzle query's message is the SQL with its parameters - here, the email
		// an anonymous caller just typed.
		const { db: missing } = createDatabase("postgres://nobody:hunter2@127.0.0.1:59999/nope");
		const broken = createApp({ suite: createMemorySuite(logger), db: missing, log: logger });

		const response = await broken.handle(
			new Request("http://localhost/api/v1/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json", "x-request-id": "rest-trace" },
				body: JSON.stringify({ email: "alice@example.com", password: "password123" }),
			}),
		);

		expect(response.status).toBe(500);
		expect(response.headers.get("x-request-id")).toBe("rest-trace");

		const raw = await response.text();

		expect(JSON.parse(raw)).toEqual({
			error: "INTERNAL",
			message: "Internal server error",
			requestId: "rest-trace",
		});
		expect(raw).not.toMatch(/select|alice|password|hunter2|59999|\.ts:\d+/i);
	});

	it("hands back one request id per REST call, in the header and in the error body", async () => {
		// No inbound x-request-id, so the server mints one, and must mint it only once.
		const response = await app.handle(
			new Request("http://localhost/api/v1/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ email: "nobody@example.com", password: "password123" }),
			}),
		);

		expect(response.status).toBe(401);

		const body = (await response.json()) as { requestId: string };

		expect(response.headers.get("x-request-id")).toBe(body.requestId);
	});

	// OpenAPI promises the client one error body on every /api/v1 failure; the generated
	// client and the mobile app's describe() read `message` from it.
	it("answers a body the schema refuses in the API's own error envelope", async () => {
		const response = await app.handle(
			new Request("http://localhost/api/v1/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json", "x-request-id": "bad-body" },
				body: JSON.stringify({ email: "alice@example.com" }),
			}),
		);

		expect(response.status).toBe(422);
		expect(response.headers.get("x-request-id")).toBe("bad-body");

		const body = (await response.json()) as Record<string, unknown>;

		expect(body).toEqual({
			error: "VALIDATION",
			message: expect.stringContaining("password"),
			requestId: "bad-body",
		});
	});

	it("answers a body that is not JSON in the API's own error envelope", async () => {
		const response = await app.handle(
			new Request("http://localhost/api/v1/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json", "x-request-id": "not-json" },
				body: "{",
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "PARSE",
			message: "The request body could not be parsed",
			requestId: "not-json",
		});
	});
});
