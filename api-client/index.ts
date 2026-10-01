// biome-ignore-all assist/source/organizeImports: the generator owns the exports between the markers, type exports included. Sorting moves those above the markers, and the next run then writes them a second time.

// Public surface. The runtime below is dung beetle's, copied in and owned here; the
// resource functions between the markers are generated from openapi.json.
//
// The `.js` extension is required: under `nodenext` resolution the specifier must match
// the emitted file, not the `.ts` source.

export type { ApiClientOptions, RequestOptions, Transport } from "./src/client.js";
export { ApiClient } from "./src/client.js";
export { readJson } from "./src/decode.js";
export { ApiError, DecodeError, HttpError, TransportError } from "./src/errors.js";
export type {
	HttpMethod,
	Operation,
	QueryParams,
	QueryValue,
	RequestBody,
	RequestHeaders,
} from "./src/operation.js";
export { deepObject, joined } from "./src/query.js";
// Everything between the markers below belongs to the generator. Edits inside
// them are overwritten on the next run; everything above is yours.
// dung-beetle:start generated exports
export {
	createPost,
	getFeed,
	login,
	logout,
	refreshSession,
} from "./src/resources/api.js";

export type {
	CreatePostBody,
	CreatePostResponse,
	GetFeedResponse,
	LoginBody,
	LoginResponse,
	LogoutBody,
	LogoutResponse,
	RefreshSessionBody,
	RefreshSessionResponse,
} from "./src/resources/api.js";
// dung-beetle:end
