import { join } from "node:path";
import type { ServiceDefinition } from "@grpc/grpc-js";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

// Relative to this file, so the process cwd does not matter.
const PROTO_DIR = join(import.meta.dirname, "..", "..", "proto");

const definition = protoLoader.loadSync(
	[join(PROTO_DIR, "post.proto"), join(PROTO_DIR, "auth.proto"), join(PROTO_DIR, "user.proto")],
	{
		// snake_case as the .proto declares it, matching what a Go or Python client sends.
		keepCase: true,
		longs: String,
		enums: String,
		defaults: true,
		oneofs: true,
		// user.proto does `import "auth.proto"`, which is resolved from here.
		includeDirs: [PROTO_DIR],
	},
);

const loaded = grpc.loadPackageDefinition(definition) as unknown as {
	bevd: {
		post: { v1: { PostService: grpc.ServiceClientConstructor } };
		auth: { v1: { AuthService: grpc.ServiceClientConstructor } };
		user: { v1: { UserService: grpc.ServiceClientConstructor } };
	};
};

export const PostServiceClient = loaded.bevd.post.v1.PostService;
export const AuthServiceClient = loaded.bevd.auth.v1.AuthService;
export const UserServiceClient = loaded.bevd.user.v1.UserService;

export const postServiceDefinition: ServiceDefinition = PostServiceClient.service;
export const authServiceDefinition: ServiceDefinition = AuthServiceClient.service;
export const userServiceDefinition: ServiceDefinition = UserServiceClient.service;
