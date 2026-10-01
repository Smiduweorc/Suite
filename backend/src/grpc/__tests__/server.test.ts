import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import type { Database } from "../../db";
import type { PublicUser } from "../../db/schema";
import { logger } from "../../lib/logger";
import { createMemorySuite } from "../../suite";
import { accessTokenFor, seedUser } from "../../test/auth";
import { createTestDatabase } from "../../test/db";
import { PostServiceClient, UserServiceClient } from "../proto";
import { createGrpcServer, startGrpcServer } from "../server";

/**
 * A real gRPC server on a real port, called by a real gRPC client with real signed
 * tokens in the metadata. Nothing is mocked: if the proto, the handlers and the
 * authorization rules disagree, this fails.
 */
interface WirePost {
	id: string;
	title: string;
	author_id: string;
	published: boolean;
}

interface WireUser {
	id: string;
	email: string;
	role: string;
}

interface PostPage {
	posts: WirePost[];
	next_cursor: string;
}

interface UserPage {
	users: WireUser[];
	next_cursor: string;
}

type Client = grpc.Client & Record<string, (...args: unknown[]) => unknown>;

/** How a gRPC caller authenticates: bearer token in the request metadata. */
function bearer(token?: string): grpc.Metadata {
	const metadata = new grpc.Metadata();

	if (token) metadata.set("authorization", `Bearer ${token}`);

	return metadata;
}

function call<T>(client: Client, method: string, request: unknown, token?: string): Promise<T> {
	return new Promise((resolve, reject) => {
		client[method]?.(request, bearer(token), (error: grpc.ServiceError | null, reply: T) =>
			error ? reject(error) : resolve(reply),
		);
	});
}

describe("grpc", () => {
	let db: Database;
	let server: grpc.Server;
	let posts: Client;
	let usersClient: Client;

	let alice: PublicUser;
	let bob: PublicUser;
	let admin: PublicUser;
	let aliceToken: string;
	let bobToken: string;
	let adminToken: string;

	beforeEach(async () => {
		db = await createTestDatabase();

		alice = await seedUser(db, { email: "alice@example.com", name: "Alice" });
		bob = await seedUser(db, { email: "bob@example.com", name: "Bob" });
		admin = await seedUser(db, { email: "root@example.com", name: "Root", role: "admin" });

		aliceToken = await accessTokenFor(db, alice);
		bobToken = await accessTokenFor(db, bob);
		adminToken = await accessTokenFor(db, admin);

		server = createGrpcServer({ db, log: logger, suite: createMemorySuite(logger) });

		const port = await startGrpcServer(server, 0);
		const address = `127.0.0.1:${port}`;
		const credentials = grpc.credentials.createInsecure();

		posts = new PostServiceClient(address, credentials) as Client;
		usersClient = new UserServiceClient(address, credentials) as Client;
	});

	afterEach(() => {
		posts.close();
		usersClient.close();
		server.forceShutdown();
	});

	describe("PostService", () => {
		it("refuses to create a post without a token", async () => {
			await expect(
				call(posts, "CreatePost", { title: "Nope", body: "x" }),
			).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
		});

		it("refuses a forged token", async () => {
			const forged = `${aliceToken.slice(0, -3)}aaa`;

			await expect(
				call(posts, "CreatePost", { title: "Nope", body: "x" }, forged),
			).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
		});

		it("creates a post as the token's owner", async () => {
			const post = await call<WirePost>(
				posts,
				"CreatePost",
				{ title: "Over gRPC", body: "hello" },
				aliceToken,
			);

			expect(post.author_id).toBe(alice.id);
			expect(post.published).toBe(false);
		});

		it("lets anonymous callers read published posts only", async () => {
			await call(posts, "CreatePost", { title: "Draft", body: "x" }, aliceToken);
			await call(
				posts,
				"CreatePost",
				{ title: "Live", body: "y", published: true },
				aliceToken,
			);

			const anon = await call<PostPage>(posts, "ListPosts", {});
			expect(anon.posts.map((p) => p.title)).toEqual(["Live"]);

			const asAlice = await call<PostPage>(posts, "ListPosts", {}, aliceToken);
			expect(asAlice.posts).toHaveLength(2);
		});

		it("pages with next_cursor, which is empty on the last page only", async () => {
			for (const title of ["p0", "p1", "p2", "p3", "p4"]) {
				await call(posts, "CreatePost", { title, body: "x", published: true }, aliceToken);
			}

			const titles: string[][] = [];
			let cursor = "";

			do {
				const page = await call<PostPage>(posts, "ListPosts", { limit: 2, cursor });

				titles.push(page.posts.map((p) => p.title));
				cursor = page.next_cursor;
			} while (cursor !== "" && titles.length < 10);

			expect(titles).toEqual([["p4", "p3"], ["p2", "p1"], ["p0"]]);
		});

		it("keeps drafts off every page for an anonymous caller", async () => {
			for (const [title, published] of [
				["live0", true],
				["draft1", false],
				["live2", true],
				["draft3", false],
			] as const) {
				await call(posts, "CreatePost", { title, body: "x", published }, aliceToken);
			}

			const first = await call<PostPage>(posts, "ListPosts", { limit: 1 });
			const second = await call<PostPage>(posts, "ListPosts", {
				limit: 1,
				cursor: first.next_cursor,
			});

			expect(first.posts.map((p) => p.title)).toEqual(["live2"]);
			expect(second).toMatchObject({ posts: [{ title: "live0" }], next_cursor: "" });
		});

		it("reads an unset limit as 20, and refuses a negative or oversized one", async () => {
			for (let i = 0; i < 21; i++) {
				await call(posts, "CreatePost", { title: `p${i}`, body: "x" }, aliceToken);
			}

			const page = await call<PostPage>(posts, "ListPosts", {}, aliceToken);
			expect(page.posts).toHaveLength(20);
			expect(page.next_cursor).not.toBe("");

			for (const limit of [101, -1]) {
				await expect(call(posts, "ListPosts", { limit })).rejects.toMatchObject({
					code: grpc.status.INVALID_ARGUMENT,
				});
			}
		});

		it("refuses a tampered cursor with INVALID_ARGUMENT", async () => {
			for (const cursor of ["not a cursor!", "bm9wZQ"]) {
				await expect(call(posts, "ListPosts", { cursor })).rejects.toMatchObject({
					code: grpc.status.INVALID_ARGUMENT,
				});
			}
		});

		it("stops one user editing another's post", async () => {
			const post = await call<WirePost>(
				posts,
				"CreatePost",
				{ title: "Alice's", body: "x", published: true },
				aliceToken,
			);

			await expect(
				call(posts, "UpdatePost", { id: post.id, title: "Hijacked" }, bobToken),
			).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
		});

		it("lets an admin edit anyone's post", async () => {
			const post = await call<WirePost>(
				posts,
				"CreatePost",
				{ title: "Alice's", body: "x", published: true },
				aliceToken,
			);

			const updated = await call<WirePost>(
				posts,
				"UpdatePost",
				{ id: post.id, title: "Moderated" },
				adminToken,
			);

			expect(updated.title).toBe("Moderated");
		});

		it("maps a validation failure to INVALID_ARGUMENT", async () => {
			// protobuf is happy with an empty string. The service's arktype schema is not.
			await expect(
				call(posts, "CreatePost", { title: "", body: "x" }, aliceToken),
			).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
		});
	});

	describe("UserService (admin only)", () => {
		it("is UNAUTHENTICATED without a token", async () => {
			await expect(call(usersClient, "ListUsers", {})).rejects.toMatchObject({
				code: grpc.status.UNAUTHENTICATED,
			});
		});

		it("is PERMISSION_DENIED for an ordinary user", async () => {
			await expect(call(usersClient, "ListUsers", {}, bobToken)).rejects.toMatchObject({
				code: grpc.status.PERMISSION_DENIED,
			});

			await expect(
				call(usersClient, "SetUserRole", { user_id: bob.id, role: "admin" }, bobToken),
			).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
		});

		it("lets an admin list and promote", async () => {
			const { users } = await call<UserPage>(usersClient, "ListUsers", {}, adminToken);

			expect(users).toHaveLength(3);

			const promoted = await call<WireUser>(
				usersClient,
				"SetUserRole",
				{ user_id: bob.id, role: "admin" },
				adminToken,
			);

			expect(promoted.role).toBe("admin");
		});

		it("pages users oldest first with next_cursor", async () => {
			const first = await call<UserPage>(usersClient, "ListUsers", { limit: 2 }, adminToken);
			const second = await call<UserPage>(
				usersClient,
				"ListUsers",
				{ limit: 2, cursor: first.next_cursor },
				adminToken,
			);

			expect(first.users.map((u) => u.id)).toEqual([alice.id, bob.id]);
			expect(first.next_cursor).not.toBe("");
			expect(second).toMatchObject({ users: [{ id: admin.id }], next_cursor: "" });
		});

		it("refuses a bad cursor or limit to an admin, and refuses a member before reading it", async () => {
			for (const request of [{ cursor: "not a cursor!" }, { limit: 101 }]) {
				await expect(
					call(usersClient, "ListUsers", request, adminToken),
				).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
			}

			await expect(
				call(usersClient, "ListUsers", { cursor: "not a cursor!" }, bobToken),
			).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
		});

		it("stops the last admin from demoting themselves", async () => {
			await expect(
				call(usersClient, "SetUserRole", { user_id: admin.id, role: "user" }, adminToken),
			).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
		});
	});
});
