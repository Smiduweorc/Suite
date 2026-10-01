import {
	deleteUser,
	ListUsersInput,
	listUsers,
	SetRoleInput,
	setUserRole,
	UserIdInput,
} from "../../services/user.service";
import { adminProcedure, router } from "../trpc";

export const userRouter = router({
	/** Oldest first. */
	list: adminProcedure.input(ListUsersInput).query(({ ctx, input }) => listUsers(ctx, input)),

	setRole: adminProcedure
		.input(SetRoleInput)
		.mutation(({ ctx, input }) => setUserRole(ctx, input)),

	delete: adminProcedure.input(UserIdInput).mutation(({ ctx, input }) => deleteUser(ctx, input)),
});
