import type { Post, PublicUser } from "../db/schema";
import type { Session } from "../services/auth.service";

/**
 * Dates become RFC 3339 strings, and fields stay snake_case because proto-loader keeps
 * the .proto names verbatim (`keepCase: true`).
 */
export interface PageRequest {
	limit?: number;
	cursor?: string;
}

/**
 * proto3 has no "unset" for scalars: an absent limit arrives as 0 and an absent cursor as
 * "", so the key is left out. Not set to undefined: to arktype `{ limit: undefined }` is a
 * present key holding an invalid value. Any other value, -1 included, is validated.
 */
export function pageRequest({ limit, cursor }: PageRequest): { limit?: number; cursor?: string } {
	return { ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) };
}

export function toWirePost(post: Post) {
	return {
		id: post.id,
		title: post.title,
		body: post.body,
		published: post.published,
		author_id: post.authorId,
		created_at: post.createdAt.toISOString(),
		updated_at: post.updatedAt.toISOString(),
	};
}

export function toWireUser(user: PublicUser) {
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		role: user.role,
		created_at: user.createdAt.toISOString(),
		updated_at: user.updatedAt.toISOString(),
	};
}

export function toWireSession(session: Session) {
	return {
		user: toWireUser(session.user),
		access_token: session.accessToken,
		refresh_token: session.refreshToken,
	};
}
