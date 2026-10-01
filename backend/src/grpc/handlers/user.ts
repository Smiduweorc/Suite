import type { UntypedServiceImplementation } from "@grpc/grpc-js";
import { deleteUser, listUsers, setUserRole } from "../../services/user.service";
import { type GrpcDeps, unary } from "../unary";
import { type PageRequest, pageRequest, toWireUser } from "../wire";

/** Admin only, enforced by `requireAdmin` in user.service.ts. */
export function userHandlers(deps: GrpcDeps): UntypedServiceImplementation {
	return {
		ListUsers: unary(deps, "ListUsers", async (ctx, request: PageRequest) => {
			const page = await listUsers(ctx, pageRequest(request));

			return { users: page.items.map(toWireUser), next_cursor: page.nextCursor ?? "" };
		}),

		SetUserRole: unary(
			deps,
			"SetUserRole",
			async (ctx, request: { user_id: string; role: string }) =>
				toWireUser(await setUserRole(ctx, { userId: request.user_id, role: request.role })),
		),

		DeleteUser: unary(deps, "DeleteUser", (ctx, request: { user_id: string }) =>
			deleteUser(ctx, { userId: request.user_id }),
		),
	};
}
