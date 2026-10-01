-- Safe with the previous version still running: it never names session_id, and its
-- inserts get one from the default. Every existing row becomes its own session (the
-- default is volatile, so each row draws its own uuid), which only matters to access
-- tokens signed by this version. Rolling the code back needs no schema rollback.
--
-- The volatile default rewrites refresh_tokens under an ACCESS EXCLUSIVE lock; the table
-- holds one row per live sign-in, so that is brief.
ALTER TABLE "refresh_tokens" ADD COLUMN "session_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
CREATE INDEX "refresh_tokens_session_idx" ON "refresh_tokens" USING btree ("session_id");