import { emailKey } from "../auth/email";
import { hashPassword } from "../auth/password";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { createDatabase } from "./index";
import { posts, users } from "./schema";

// Two accounts, so you can watch authorization bite: sign in as alice and edit bob's post.
const { db, pool } = createDatabase(env.DATABASE_URL);

const [admin, member] = await db
	.insert(users)
	.values([
		{
			email: "alice@example.com",
			emailKey: emailKey("alice@example.com"),
			name: "Alice",
			passwordHash: await hashPassword("password123"),
			role: "admin",
		},
		{
			email: "bob@example.com",
			emailKey: emailKey("bob@example.com"),
			name: "Bob",
			passwordHash: await hashPassword("password123"),
			role: "user",
		},
	])
	.returning();

if (!admin || !member) {
	throw new Error("Seed failed: users were not inserted");
}

await db.insert(posts).values([
	{
		title: "Hello Elysia",
		body: "Bun is the runtime, Elysia is the server.",
		published: true,
		authorId: admin.id,
	},
	{
		title: "Typed end to end",
		body: "tRPC carries the router types into Vue.",
		published: true,
		authorId: member.id,
	},
	{
		// Only Bob and admins can see this one.
		title: "Bob's draft",
		body: "Not published yet.",
		published: false,
		authorId: member.id,
	},
]);

// The shared password is in the README; a log line is no place for a credential.
logger.info({ admin: admin.email, user: member.email }, "seeded");

await pool.end();
