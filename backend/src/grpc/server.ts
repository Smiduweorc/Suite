import * as grpc from "@grpc/grpc-js";
import { authHandlers } from "./handlers/auth";
import { postHandlers } from "./handlers/post";
import { userHandlers } from "./handlers/user";
import { authServiceDefinition, postServiceDefinition, userServiceDefinition } from "./proto";
import type { GrpcDeps } from "./unary";

export function createGrpcServer(deps: GrpcDeps): grpc.Server {
	const server = new grpc.Server();

	server.addService(postServiceDefinition, postHandlers(deps));
	server.addService(authServiceDefinition, authHandlers(deps));
	server.addService(userServiceDefinition, userHandlers(deps));

	return server;
}

/** Pass port 0 for a free one (the tests do). */
export function startGrpcServer(server: grpc.Server, port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		server.bindAsync(
			`0.0.0.0:${port}`,
			grpc.ServerCredentials.createInsecure(),
			(error, boundPort) => (error ? reject(error) : resolve(boundPort)),
		);
	});
}
