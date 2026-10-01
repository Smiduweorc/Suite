import { randomUUID } from "node:crypto";
import { emailKey } from "../auth/email";
import { signAccessToken } from "../auth/jwt";
import { hashPassword } from "../auth/password";
import type { Actor } from "../auth/policy";
import { generateRefreshToken, hashRefreshToken, refreshTokenExpiresAt } from "../auth/tokens";
import type { Database } from "../db";
import { type PublicUser, refreshTokens, toPublicUser, type UserRole, users } from "../db/schema";

interface SeedUserOptions {
	email?: string;
	name?: string;
	password?: string;
	role?: UserRole;
}

/** Skips registration. */
export async function seedUser(
	db: Database,
	{
		email = "user@example.com",
		name = "User",
		password = "password123",
		role = "user",
	}: SeedUserOptions = {},
): Promise<PublicUser> {
	const [user] = await db
		.insert(users)
		.values({
			email,
			emailKey: emailKey(email),
			name,
			passwordHash: await hashPassword(password),
			role,
		})
		.returning();

	if (!user) throw new Error("seedUser: insert returned no row");

	return toPublicUser(user);
}

export function actorFor(user: PublicUser): Actor {
	return { id: user.id, email: user.email, role: user.role };
}

/**
 * A real signed token on a live session, for the tests that go over the wire. `claims`
 * overrides what the token says without touching the user row.
 */
export async function accessTokenFor(
	db: Database,
	user: PublicUser,
	claims: { role?: UserRole } = {},
): Promise<string> {
	const sessionId = randomUUID();

	await db.insert(refreshTokens).values({
		userId: user.id,
		sessionId,
		tokenHash: hashRefreshToken(generateRefreshToken()),
		expiresAt: refreshTokenExpiresAt(),
	});

	return signAccessToken({
		sub: user.id,
		email: user.email,
		role: claims.role ?? user.role,
		sid: sessionId,
	});
}
