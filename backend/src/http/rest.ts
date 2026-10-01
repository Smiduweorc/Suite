import { Elysia, t } from "elysia";
import { parseBearer } from "lacewing";
import { fingerprint, MycocepurusError } from "mycocepurus-smithii";
import { readKey, statusFor } from "mycocepurus-smithii/http";
import { verifyAccessToken } from "../auth/jwt";
import type { Actor } from "../auth/policy";
import type { Database } from "../db";
import type { Post, PublicUser } from "../db/schema";
import { AppError, type ErrorCode } from "../lib/errors";
import { type Logger, requestIdOf } from "../lib/logger";
import { login, logout, refresh, type Session } from "../services/auth.service";
import type { ServiceCtx } from "../services/context";
import { publicFeed } from "../services/feed.service";
import { createPost } from "../services/post.service";
import type { IdempotentResult, Suite } from "../suite";
import { LedgerUnavailableError } from "../suite/redis";

/**
 * /api/v1, the mobile app's door. A REST surface beside tRPC because dung beetle generates
 * `@suite/api-client` from its OpenAPI document (/openapi/json).
 *
 * Bearer-only, no cookies, so no CSRF check: a cross-site page cannot attach an
 * Authorization header.
 */

const HTTP_STATUS: Record<ErrorCode, number> = {
	BAD_REQUEST: 400,
	UNAUTHORIZED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	CONFLICT: 409,
	UNAVAILABLE: 503,
	INTERNAL: 500,
};

// What OpenAPI describes, so what the client is typed to.

const ErrorBody = t.Object({
	error: t.String({ description: "Machine-readable code" }),
	message: t.String(),
	requestId: t.String(),
});

const UserDto = t.Object({
	id: t.String({ format: "uuid" }),
	email: t.String(),
	name: t.String(),
	role: t.Union([t.Literal("user"), t.Literal("admin")]),
});

const SessionDto = t.Object({
	user: UserDto,
	accessToken: t.String({ description: "lacewing at+jwt. Send as `Authorization: Bearer`." }),
	refreshToken: t.String({ description: "Opaque, single use. Trade it at /auth/refresh." }),
});

const PostDto = t.Object({
	id: t.String({ format: "uuid" }),
	title: t.String(),
	body: t.String(),
	published: t.Boolean(),
	authorId: t.String({ format: "uuid" }),
	createdAt: t.String({ format: "date-time" }),
	updatedAt: t.String({ format: "date-time" }),
});

const FeedPostDto = t.Omit(PostDto, ["published"]);

const FeedDto = t.Object({
	posts: t.Array(FeedPostDto),
	cache: t.Object(
		{
			state: t.Union([
				t.Literal("fresh"),
				t.Literal("stale"),
				t.Literal("retained"),
				t.Literal("miss"),
			]),
			ageMs: t.Number(),
		},
		{ description: "Straight from Repletes: where this answer came from, and how old it is." },
	),
});

const errors = {
	400: ErrorBody,
	401: ErrorBody,
	409: ErrorBody,
	422: ErrorBody,
	503: ErrorBody,
};

function toUserDto(user: PublicUser) {
	return { id: user.id, email: user.email, name: user.name, role: user.role };
}

function toSessionDto(session: Session) {
	return {
		user: toUserDto(session.user),
		accessToken: session.accessToken,
		refreshToken: session.refreshToken,
	};
}

function toPostDto(post: Post) {
	return {
		id: post.id,
		title: post.title,
		body: post.body,
		published: post.published,
		authorId: post.authorId,
		createdAt: post.createdAt.toISOString(),
		updatedAt: post.updatedAt.toISOString(),
	};
}

/** Missing or bad credentials resolve to anonymous; the route decides if that is fine. */
async function bearerActor(db: Database, request: Request): Promise<Actor | null> {
	if (request.headers.get("authorization") === null) return null;

	try {
		const payload = await verifyAccessToken(db, parseBearer(request));

		return { id: payload.sub, email: payload.email, role: payload.role };
	} catch {
		return null;
	}
}

export interface RestDeps {
	db: Database;
	log: Logger;
	suite: Suite;
}

/** An AppError as a status and the body a client parses. Anything else is rethrown. */
function failure(error: unknown, requestId: string): { status: number; body: unknown } {
	if (error instanceof AppError) {
		return {
			status: HTTP_STATUS[error.code],
			body: { error: error.code, message: error.message, requestId },
		};
	}

	throw error;
}

export function restV1({ db, log: root, suite }: RestDeps) {
	async function contextFor(request: Request): Promise<ServiceCtx & { requestId: string }> {
		const requestId = requestIdOf(request);
		const actor = await bearerActor(db, request);
		const log = root.child({
			requestId,
			transport: "rest",
			...(actor ? { userId: actor.id } : {}),
		});

		return { db, log, actor, suite, requestId };
	}

	return new Elysia({ prefix: "/api/v1", tags: ["v1"] })
		.post(
			"/auth/login",
			async ({ request, body, set }) => {
				const ctx = await contextFor(request);

				try {
					return toSessionDto(await login(ctx, body));
				} catch (error) {
					const { status, body: payload } = failure(error, ctx.requestId);
					set.status = status;

					return payload as typeof ErrorBody.static;
				}
			},
			{
				body: t.Object({ email: t.String(), password: t.String() }),
				response: { 200: SessionDto, ...errors },
				detail: {
					summary: "Sign in",
					description:
						"Any alias of the account's mailbox works: the email is canonicalized with phasmid before lookup.",
				},
			},
		)

		.post(
			"/auth/refresh",
			async ({ request, body, set }) => {
				const ctx = await contextFor(request);

				try {
					return toSessionDto(await refresh(ctx, body.refreshToken));
				} catch (error) {
					const { status, body: payload } = failure(error, ctx.requestId);
					set.status = status;

					return payload as typeof ErrorBody.static;
				}
			},
			{
				body: t.Object({ refreshToken: t.String() }),
				response: { 200: SessionDto, ...errors },
				detail: {
					summary: "Rotate a session",
					description:
						"Single use: the refresh token sent is revoked, a new one returned.",
				},
			},
		)

		.post(
			// No access token consulted. Whoever holds the refresh token can already trade it
			// at /auth/refresh, which revokes it too, so ending it here grants nothing new.
			// Requiring the access token would 401 a phone that slept past its lifetime and
			// leave a live refresh token on the server. Every well-formed request gets the
			// same 200, so this is no oracle for whether a token is live.
			"/auth/logout",
			async ({ request, body, set }) => {
				const ctx = await contextFor(request);

				try {
					return await logout(ctx, body.refreshToken);
				} catch (error) {
					const { status, body: payload } = failure(error, ctx.requestId);
					set.status = status;

					return payload as typeof ErrorBody.static;
				}
			},
			{
				body: t.Object({ refreshToken: t.String() }),
				// Not `...errors`: this route never answers 401.
				response: {
					200: t.Object({ ok: t.Literal(true) }),
					400: ErrorBody,
					422: ErrorBody,
				},
				detail: {
					summary: "End a session",
					description:
						"Revokes the refresh token sent, so it can no longer be traded at /auth/refresh. Needs no access token: the refresh token is the credential. Idempotent: an already revoked, expired or unknown token gets the same 200, so a retry or a second sign-out is never an error. Ends this one session only; other devices stay signed in. Access tokens issued to this session stop working at once.",
				},
			},
		)

		.get(
			"/feed",
			async ({ request, set }) => {
				const ctx = await contextFor(request);

				try {
					const feed = await publicFeed(ctx);
					set.headers["x-cache"] = feed.cache.state;

					return feed;
				} catch (error) {
					const { status, body: payload } = failure(error, ctx.requestId);
					set.status = status;

					return payload as typeof ErrorBody.static;
				}
			},
			{
				response: { 200: FeedDto, ...errors },
				detail: {
					summary: "Public feed",
					description:
						"Published posts, newest first. Cached with Repletes (stale-while-revalidate, stale-if-error); `cache.state` says which.",
				},
			},
		)

		.post(
			"/posts",
			async ({ request, body, set }) => {
				const ctx = await contextFor(request);
				const refuse = (status: number, error: string, message: string) => {
					set.status = status;

					return { error, message, requestId: ctx.requestId };
				};

				// The actor is the ledger's scope, so one user can never replay another's
				// response by guessing their key.
				if (!ctx.actor) return refuse(401, "UNAUTHORIZED", "You must be signed in");

				try {
					const key = readKey(request.headers);
					// A key reused with a different body is a 422, not a replay of the wrong post.
					const print = await fingerprint(["POST /api/v1/posts", JSON.stringify(body)]);

					const outcome = await suite.idempotency.run(
						{ scope: ctx.actor.id, key, fingerprint: print },
						async (): Promise<IdempotentResult> => {
							try {
								return {
									status: 201,
									body: toPostDto(await createPost(ctx, body)),
								};
							} catch (error) {
								// A validation failure is an outcome too, and is replayed as one.
								return failure(error, ctx.requestId);
							}
						},
					);

					set.status = outcome.value.status;
					set.headers["idempotent-replayed"] = String(outcome.state === "replayed");

					ctx.log.info(
						{
							event: "post.create",
							idempotency: outcome.state,
							status: outcome.value.status,
						},
						"idempotent create",
					);

					return outcome.value.body as typeof PostDto.static;
				} catch (error) {
					if (error instanceof MycocepurusError) {
						return refuse(statusFor(error), error.code, error.message);
					}
					if (error instanceof LedgerUnavailableError) {
						ctx.log.warn({ err: error }, "idempotency ledger unavailable");

						// Refused rather than performed without the exactly-once guarantee.
						return refuse(503, "UNAVAILABLE", "Try again shortly");
					}

					throw error;
				}
			},
			{
				body: t.Object({
					title: t.String(),
					body: t.String(),
					published: t.Optional(t.Boolean()),
				}),
				headers: t.Object({
					// Optional to the validator so mycocepurus-smithii decides: absent is
					// its 400 `missing-key`, not a generic schema error.
					"idempotency-key": t.Optional(
						t.String({
							description:
								'Required. An RFC 8941 String: a quoted value, e.g. `"3f1c..."`. Retries must reuse it.',
						}),
					),
				}),
				response: { 201: PostDto, ...errors },
				detail: {
					summary: "Create a post, exactly once",
					description:
						"Idempotent per the IETF Idempotency-Key draft (mycocepurus-smithii): a retry with the same key replays the first response; the same key with a different body is 422; a concurrent duplicate is 409.",
					security: [{ bearer: [] }],
				},
			},
		);
}
