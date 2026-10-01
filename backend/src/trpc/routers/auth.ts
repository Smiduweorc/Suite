import type { PublicUser } from "../../db/schema";
import { clearedCookies, sessionCookies } from "../../http/cookies";
import { generateCsrfToken } from "../../http/csrf";
import {
	LoginInput,
	login,
	logout,
	me,
	RegisterInput,
	refresh,
	register,
	type Session,
} from "../../services/auth.service";
import type { Context } from "../context";
import { protectedProcedure, publicProcedure, router } from "../trpc";

/**
 * The tokens go only into httpOnly cookies, never the response body: if the browser cannot
 * read them, neither can injected script. Over gRPC the same Session goes on the wire.
 */
function commitSession(ctx: Context, session: Session): PublicUser {
	const csrfToken = generateCsrfToken();

	for (const cookie of sessionCookies(session.accessToken, session.refreshToken, csrfToken)) {
		ctx.resHeaders.append("set-cookie", cookie);
	}

	return session.user;
}

export const authRouter = router({
	register: publicProcedure
		.input(RegisterInput)
		.mutation(async ({ ctx, input }) => commitSession(ctx, await register(ctx, input))),

	login: publicProcedure
		.input(LoginInput)
		.mutation(async ({ ctx, input }) => commitSession(ctx, await login(ctx, input))),

	/** No input: the refresh token comes from the cookie. Rotates it (auth.service.ts). */
	refresh: publicProcedure.mutation(async ({ ctx }) =>
		commitSession(ctx, await refresh(ctx, ctx.refreshToken)),
	),

	/** Revokes the refresh token and clears the cookies. */
	logout: publicProcedure.mutation(async ({ ctx }) => {
		await logout(ctx, ctx.refreshToken);

		for (const cookie of clearedCookies()) {
			ctx.resHeaders.append("set-cookie", cookie);
		}

		return { ok: true as const };
	}),

	/** 401 when signed out, which is how the client knows. */
	me: protectedProcedure.query(({ ctx }) => me(ctx)),
});
