import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Elysia } from "elysia";
import { env } from "./config/env";
import type { Database } from "./db";
import { restV1 } from "./http/rest";
import { type Logger, requestIdFrom, requestIdOf } from "./lib/logger";
import type { Suite } from "./suite";
import { createContextFactory } from "./trpc/context";
import { appRouter } from "./trpc/routers";

/** createGrpcServer takes the same shape. The logger is injected so tests can silence it. */
export interface AppDeps {
	db: Database;
	log: Logger;
	suite: Suite;
}

export function createApp({ db, log: root, suite }: AppDeps) {
	return (
		new Elysia()
			.use(cors({ origin: env.CORS_ORIGIN, credentials: true }))
			// /openapi is the browsable docs, /openapi/json the document dung beetle generates
			// @suite/api-client from (see scripts/openapi.ts).
			.use(
				openapi({
					path: "/openapi",
					documentation: {
						info: {
							title: "Suite API",
							version: "1.0.0",
							description:
								"The bearer-only REST surface the mobile app uses. The web app uses tRPC.",
						},
						components: {
							securitySchemes: {
								bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
							},
						},
					},
				}),
			)

			// /trpc is skipped in the access line: it logs itself, per procedure.
			.derive(({ request }) => ({
				requestId: requestIdOf(request),
				startedAt: performance.now(),
			}))
			.onAfterHandle(({ set, requestId }) => {
				set.headers["x-request-id"] = requestId;
			})
			.onAfterResponse(({ request, set, requestId, startedAt, path }) => {
				if (path.startsWith("/trpc")) return;

				root.info(
					{
						requestId,
						transport: "http",
						method: request.method,
						path,
						status: set.status,
						durationMs: Math.round(performance.now() - startedAt),
					},
					"http",
				);
			})
			// Validation and parse failures get the { error, message, requestId } envelope
			// OpenAPI promises for /api/v1. Other Elysia refusals (an unknown route) keep its
			// answer. Anything else is a bug, and Elysia's default would send its message as
			// the body: for a failed query, the SQL and its parameters.
			//
			// requestIdOf, not the derive: an error thrown before the derive ran (a body that
			// does not parse) has no id yet.
			.onError(({ code, error, path, request, set }) => {
				const requestId = requestIdOf(request);

				// onAfterHandle does not run for a failed request.
				set.headers["x-request-id"] = requestId;

				if (code === "VALIDATION") {
					root.info({ requestId, code, path }, "request refused");

					const first = error.all[0];
					set.status = 422;

					return {
						error: "VALIDATION",
						message: first
							? `${first.path || "body"}: ${first.summary ?? first.message}`
							: "The request does not match the schema",
						requestId,
					};
				}

				if (code === "PARSE") {
					root.info({ requestId, code, path }, "request refused");
					set.status = 400;

					return {
						error: "PARSE",
						message: "The request body could not be parsed",
						requestId,
					};
				}

				if (code !== "UNKNOWN" && code !== "INTERNAL_SERVER_ERROR") {
					root.info({ requestId, code, path }, "request refused");

					return;
				}

				root.error({ requestId, code, path, err: error }, "unhandled request error");

				set.status = 500;

				return { error: "INTERNAL", message: "Internal server error", requestId };
			})

			// Reading a Dependency's health changes nothing, so a load balancer may poll this
			// as often as it likes.
			.get("/health", () => ({
				status: "ok",
				uptime: process.uptime(),
				dependencies: [suite.postgres.health()],
			}))

			.use(restV1({ db, log: root, suite }))

			// `.mount` hands over the untouched Request: Elysia parses a POST body before a
			// normal handler runs, and tRPC would find the stream already consumed.
			//
			// It strips the prefix, so the adapter sees `/post.create`; hence `endpoint: ""`.
			// Setting it to "/trpc" silently 404s every call.
			//
			// It also rebuilds the Request, so no per-request state crosses from Elysia's
			// hooks. The request id is re-derived from the header, the one thing that survives.
			.mount("/trpc", (request: Request) => {
				const requestId = requestIdFrom(request.headers.get("x-request-id"));
				const log = root.child({ requestId, transport: "trpc" });

				return fetchRequestHandler({
					endpoint: "",
					req: request,
					router: appRouter,
					createContext: (options) => {
						options.resHeaders.set("x-request-id", requestId);

						return createContextFactory({ db, suite, requestId, log })(options);
					},
					// What never reaches a resolver: an unknown procedure, a malformed body.
					onError({ error, path }) {
						if (error.code === "INTERNAL_SERVER_ERROR") {
							log.error({ procedure: path ?? "<none>", err: error }, "trpc failed");
						} else {
							log.info(
								{ procedure: path ?? "<none>", code: error.code },
								"trpc rejected",
							);
						}
					},
				});
			})
	);
}

export type App = ReturnType<typeof createApp>;
