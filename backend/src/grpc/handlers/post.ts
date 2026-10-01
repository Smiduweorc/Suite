import type { UntypedServiceImplementation } from "@grpc/grpc-js";
import {
	createPost,
	deletePost,
	getPost,
	listPosts,
	updatePost,
} from "../../services/post.service";
import { type GrpcDeps, unary } from "../unary";
import { pageRequest, toWirePost } from "../wire";

interface ListPostsRequest {
	limit?: number;
	published_only?: boolean;
	cursor?: string;
}

interface CreatePostRequest {
	title: string;
	body: string;
	published?: boolean;
}

interface UpdatePostRequest {
	id: string;
	title?: string;
	body?: string;
	published?: boolean;
}

/** No authorization here: post.service.ts settles who may read or change a post. */
export function postHandlers(deps: GrpcDeps): UntypedServiceImplementation {
	return {
		ListPosts: unary(deps, "ListPosts", async (ctx, request: ListPostsRequest) => {
			const page = await listPosts(ctx, {
				...pageRequest(request),
				publishedOnly: request.published_only ?? false,
			});

			return { posts: page.items.map(toWirePost), next_cursor: page.nextCursor ?? "" };
		}),

		GetPost: unary(deps, "GetPost", async (ctx, request: { id: string }) =>
			toWirePost(await getPost(ctx, request)),
		),

		CreatePost: unary(deps, "CreatePost", async (ctx, request: CreatePostRequest) =>
			toWirePost(await createPost(ctx, request)),
		),

		UpdatePost: unary(deps, "UpdatePost", async (ctx, request: UpdatePostRequest) =>
			toWirePost(await updatePost(ctx, request)),
		),

		DeletePost: unary(deps, "DeletePost", (ctx, request: { id: string }) =>
			deletePost(ctx, request),
		),
	};
}
