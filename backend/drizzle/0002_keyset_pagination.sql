-- Hand-edited from drizzle-kit's output: the DROP moved last. drizzle's migrator runs
-- every migration in one transaction, so CONCURRENTLY is not available, and DROP INDEX
-- holds an ACCESS EXCLUSIVE lock on posts until commit. Last, that lock blocks readers
-- for an instant instead of for both index builds. The builds themselves block writes
-- (not reads) to posts and users while they run.
--
-- Safe with the previous version still running: it orders posts by created_at alone,
-- which posts_created_at_id_idx serves as well as the index it replaces, and it never
-- names an index. Rolling the code back needs no schema rollback.
CREATE INDEX "posts_created_at_id_idx" ON "posts" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "users_created_at_id_idx" ON "users" USING btree ("created_at","id");--> statement-breakpoint
DROP INDEX "posts_created_at_idx";
