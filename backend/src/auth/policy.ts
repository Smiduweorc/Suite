import type { UserRole } from "../db/schema";

/** Who is making this call; null where it is used means an anonymous request. */
export interface Actor {
	id: string;
	email: string;
	role: UserRole;
}

/**
 * You can edit your own, admins can edit anyone.
 *
 * Keep this file dependency-free (no AppError, no database, nothing from Node): the Vue
 * app imports it as `@bevd/backend/policy` to decide which buttons to draw. The throwing
 * guards live in actor.ts. The frontend call is a courtesy; the service's call decides.
 */
export function canMutate(actor: { id: string; role: UserRole }, ownerId: string): boolean {
	return actor.role === "admin" || actor.id === ownerId;
}
