import {
	boolean,
	index,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

/** Everything authorization hangs off. Add roles here and the TS union follows. */
export const userRole = pgEnum("user_role", ["user", "admin"]);

export type UserRole = (typeof userRole.enumValues)[number];

export const users = pgTable(
	"users",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		/** As the user typed it (lowercased). For display and for mail - not for identity. */
		email: text("email").notNull(),
		/** The canonical mailbox (auth/email.ts). This is what is unique. */
		emailKey: text("email_key").notNull(),
		name: text("name").notNull(),
		passwordHash: text("password_hash").notNull(),
		role: userRole("role").notNull().default("user"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("users_email_key_idx").on(table.emailKey),
		// The keyset for user.list: (created_at, id) is the page order and the cursor.
		index("users_created_at_id_idx").on(table.createdAt, table.id),
	],
);

/**
 * Rows, not JWTs: a signed refresh JWT stays valid until it expires, so logout could not
 * revoke it.
 *
 * `sessionId` is one sign-in: rotation revokes the row and inserts its successor with the
 * same value. Access tokens carry it as `sid`, and auth/jwt.ts accepts one only while its
 * session still has a live row, so ending the session ends its access tokens too.
 */
export const refreshTokens = pgTable(
	"refresh_tokens",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		sessionId: uuid("session_id").notNull().defaultRandom(),
		tokenHash: text("token_hash").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("refresh_tokens_hash_idx").on(table.tokenHash),
		index("refresh_tokens_user_idx").on(table.userId),
		// Every authenticated request looks its session up by this.
		index("refresh_tokens_session_idx").on(table.sessionId),
	],
);

export const posts = pgTable(
	"posts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		title: text("title").notNull(),
		body: text("body").notNull(),
		published: boolean("published").notNull().default(false),
		// Deleting a user takes their posts with them.
		authorId: uuid("author_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		// The keyset for post.list, read backwards for newest first. Also serves the feed's
		// ORDER BY created_at DESC.
		index("posts_created_at_id_idx").on(table.createdAt, table.id),
		index("posts_author_idx").on(table.authorId),
	],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;

/** A user with the password hash stripped. Never send `User` itself to a client. */
export type PublicUser = Omit<User, "passwordHash">;

export function toPublicUser(user: User): PublicUser {
	const { passwordHash: _passwordHash, ...rest } = user;

	return rest;
}
