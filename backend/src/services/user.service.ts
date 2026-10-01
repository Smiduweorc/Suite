import { type } from "arktype";
import { eq, getTableColumns } from "drizzle-orm";
import { requireAdmin } from "../auth/actor";
import { revokeAllSessions } from "../auth/sessions";
import { type PublicUser, toPublicUser, users } from "../db/schema";
import { AppError, parseInput } from "../lib/errors";
import type { ServiceCtx } from "./context";
import {
	after,
	DEFAULT_PAGE_SIZE,
	decodeCursor,
	keysetOrder,
	type Page,
	PageInput,
	positionOf,
	toPage,
} from "./page";

export const ListUsersInput = PageInput;

const USER_ORDER = { createdAt: users.createdAt, id: users.id, direction: "asc" } as const;

export const SetRoleInput = type({
	userId: "string.uuid",
	role: "'user' | 'admin'",
});

export const UserIdInput = type({ userId: "string.uuid" });

/**
 * Admin-only, checked here and not only in `adminProcedure`, because gRPC reaches this
 * code too. Oldest first: new sign-ups land on the last page.
 */
export async function listUsers(ctx: ServiceCtx, input: unknown): Promise<Page<PublicUser>> {
	requireAdmin(ctx.actor);
	const { limit = DEFAULT_PAGE_SIZE, cursor } = parseInput(ListUsersInput, input);

	const rest = cursor ? after(USER_ORDER, decodeCursor("users", cursor)) : undefined;

	// The hash is never selected, so it cannot be returned by mistake further down.
	const { passwordHash: _passwordHash, ...columns } = getTableColumns(users);

	const rows = await ctx.db
		.select({ row: columns, at: positionOf(users.createdAt) })
		.from(users)
		.where(rest)
		.orderBy(...keysetOrder(USER_ORDER))
		.limit(limit + 1);

	return toPage("users", rows, limit);
}

export async function setUserRole(ctx: ServiceCtx, input: unknown): Promise<PublicUser> {
	const admin = requireAdmin(ctx.actor);
	const { userId, role } = parseInput(SetRoleInput, input);

	// Otherwise the last admin can demote themselves and nobody can promote anyone again.
	if (userId === admin.id && role !== "admin") {
		throw new AppError("BAD_REQUEST", "You cannot remove your own admin role");
	}

	const [updated] = await ctx.db
		.update(users)
		.set({ role, updatedAt: new Date() })
		.where(eq(users.id, userId))
		.returning();

	if (!updated) {
		throw new AppError("NOT_FOUND", `No user with id ${userId}`);
	}

	// Revoking every session also kills the access tokens that still carry the old role
	// (auth/jwt.ts), so the change takes hold on the user's next request.
	await revokeAllSessions(ctx.db, userId);

	ctx.log.warn({ event: "user.role_changed", actorId: admin.id, userId, role }, "role changed");

	return toPublicUser(updated);
}

export async function deleteUser(ctx: ServiceCtx, input: unknown): Promise<{ id: string }> {
	const admin = requireAdmin(ctx.actor);
	const { userId } = parseInput(UserIdInput, input);

	if (userId === admin.id) {
		throw new AppError("BAD_REQUEST", "You cannot delete your own account");
	}

	const [deleted] = await ctx.db.delete(users).where(eq(users.id, userId)).returning();

	if (!deleted) {
		throw new AppError("NOT_FOUND", `No user with id ${userId}`);
	}

	ctx.log.warn({ event: "user.deleted", actorId: admin.id, userId }, "user deleted");

	// Posts and refresh tokens go with them - see the cascade in db/schema.ts.
	return { id: deleted.id };
}
