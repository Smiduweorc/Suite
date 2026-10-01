import type { Metadata } from "@grpc/grpc-js";
import { parseBearer } from "lacewing";
import { verifyAccessToken } from "../auth/jwt";
import type { Actor } from "../auth/policy";
import type { Database } from "../db";

/**
 * The gRPC counterpart of the cookie read in trpc/context.ts: the access token arrives as
 * `authorization: Bearer <token>` metadata, parsed by lacewing's strict RFC 6750
 * parseBearer (exactly one `Bearer <token>`, exact-case scheme). No CSRF check: there is
 * no cookie jar for a cross-site page to ride.
 *
 * A missing or bad token resolves to null and the service decides (reads yes, writes no).
 */
export async function actorFromMetadata(db: Database, metadata: Metadata): Promise<Actor | null> {
	const header = metadata.get("authorization")[0];

	if (typeof header !== "string") return null;

	try {
		const payload = await verifyAccessToken(db, parseBearer(header));

		return { id: payload.sub, email: payload.email, role: payload.role };
	} catch {
		return null;
	}
}
