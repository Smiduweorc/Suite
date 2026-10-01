-- Hand-edited from drizzle-kit's output so it also applies to a database that already has
-- users. Existing rows are backfilled with lower(email) - what the old unique index
-- enforced - not with phasmid's canonical form, which only the app can compute. Rows
-- registered from here on get the real canonical key.
ALTER TABLE "users" ADD COLUMN "email_key" text;--> statement-breakpoint
UPDATE "users" SET "email_key" = lower("email");--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email_key" SET NOT NULL;--> statement-breakpoint
DROP INDEX "users_email_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key_idx" ON "users" USING btree ("email_key");
