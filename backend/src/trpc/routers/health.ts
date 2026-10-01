import { pingDatabase } from "../../db";
import { publicProcedure, router } from "../trpc";

export const healthRouter = router({
	ping: publicProcedure.query(() => ({
		status: "ok" as const,
		ts: new Date().toISOString(),
	})),

	db: publicProcedure.query(async ({ ctx }) => {
		await pingDatabase(ctx.db);

		return { database: "reachable" as const };
	}),

	/** firefly's view: breaker state, in-flight calls. */
	dependencies: publicProcedure.query(({ ctx }) => [ctx.suite.postgres.health()]),
});
