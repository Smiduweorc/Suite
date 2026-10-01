import * as grpc from "@grpc/grpc-js";
import type { Database } from "../db";
import { AppError, type ErrorCode } from "../lib/errors";
import { type Logger, requestIdFrom } from "../lib/logger";
import type { ServiceCtx } from "../services/context";
import type { Suite } from "../suite";
import { actorFromMetadata } from "./metadata";

const GRPC_CODE: Record<ErrorCode, grpc.status> = {
	BAD_REQUEST: grpc.status.INVALID_ARGUMENT,
	UNAUTHORIZED: grpc.status.UNAUTHENTICATED,
	FORBIDDEN: grpc.status.PERMISSION_DENIED,
	NOT_FOUND: grpc.status.NOT_FOUND,
	CONFLICT: grpc.status.ALREADY_EXISTS,
	UNAVAILABLE: grpc.status.UNAVAILABLE,
	INTERNAL: grpc.status.INTERNAL,
};

function serviceError(code: grpc.status, message: string): grpc.ServiceError {
	return Object.assign(new Error(message), {
		code,
		details: message,
		metadata: new grpc.Metadata(),
		name: "ServiceError",
	});
}

function toServiceError(error: unknown, log: Logger, durationMs: number): grpc.ServiceError {
	if (error instanceof AppError) {
		log.info({ durationMs, code: error.code }, "grpc rejected");

		return serviceError(GRPC_CODE[error.code], error.message);
	}

	log.error({ durationMs, err: error }, "grpc failed");

	return serviceError(grpc.status.INTERNAL, "Internal error");
}

export interface GrpcDeps {
	db: Database;
	log: Logger;
	suite: Suite;
}

/**
 * The gRPC counterpart of tRPC's `observe` middleware plus `createContext`, and the only
 * place a gRPC call becomes a ServiceCtx.
 */
export function unary<Request, Reply>(
	{ db, log: root, suite }: GrpcDeps,
	method: string,
	handler: (ctx: ServiceCtx, request: Request) => Promise<Reply>,
) {
	return (
		call: grpc.ServerUnaryCall<Request, Reply>,
		callback: grpc.sendUnaryData<Reply>,
	): void => {
		const requestId = requestIdFrom(call.metadata.get("x-request-id")[0]?.toString());
		const startedAt = performance.now();
		const elapsed = () => Math.round(performance.now() - startedAt);

		let log = root.child({ requestId, transport: "grpc", method });

		actorFromMetadata(db, call.metadata)
			.then((actor) => {
				// The id, never the email (see trpc/context.ts).
				if (actor) log = log.child({ userId: actor.id, role: actor.role });

				return handler({ db, log, actor, suite }, call.request);
			})
			.then((reply) => {
				log.info({ durationMs: elapsed() }, "grpc ok");
				callback(null, reply);
			})
			.catch((error: unknown) => {
				callback(toServiceError(error, log, elapsed()), null);
			});
	};
}
