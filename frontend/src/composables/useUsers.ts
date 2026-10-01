import { trpc } from "../lib/trpc";
import { useAsync } from "./useAsync";
import { usePaged } from "./usePaged";

export type ManagedUser = Awaited<ReturnType<typeof trpc.user.list.query>>["items"][number];

/** Mounted only for admins, but the security control is the service's role check. */
export function useUsers() {
	const { busy, error, run } = useAsync();

	const {
		items: users,
		nextCursor,
		loading,
		loadError,
		load,
		loadMore,
	} = usePaged((from) => trpc.user.list.query(from), "Could not load users");

	const setRole = (target: ManagedUser, role: "user" | "admin") =>
		run(async () => {
			const updated = await trpc.user.setRole.mutate({ userId: target.id, role });

			users.value = users.value.map((u) => (u.id === updated.id ? updated : u));
		});

	const remove = (target: ManagedUser) =>
		run(async () => {
			await trpc.user.delete.mutate({ userId: target.id });

			users.value = users.value.filter((u) => u.id !== target.id);
		});

	return { users, nextCursor, loading, loadError, busy, error, load, loadMore, setRole, remove };
}
