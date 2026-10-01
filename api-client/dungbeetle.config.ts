import type { GeneratorConfig } from "./tools/generator/config.js";

/**
 * Regenerate after the API changes:
 *
 *   bun run --cwd backend openapi    # backend -> openapi.json
 *   bun run --cwd api-client generate
 *
 * Then read the diff. The generator prints the public names it added and removed, so a
 * change to this package's API is something a person sees in review.
 */
const config: GeneratorConfig = {
	spec: "./openapi.json",

	// Every path starts /api/v1, so the path rules would read "Api" and "V1" into every
	// name. These are the names a caller should see instead.
	names: {
		"POST /api/v1/auth/login": "login",
		"POST /api/v1/auth/refresh": "refreshSession",
		"POST /api/v1/auth/logout": "logout",
		"GET /api/v1/feed": "getFeed",
		"POST /api/v1/posts": "createPost",
	},
};

export default config;
