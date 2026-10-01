import {
	ApiClient,
	type CreatePostBody,
	type CreatePostResponse,
	createPost,
	type GetFeedResponse,
	getFeed,
	HttpError,
	type LoginResponse,
	login,
	type Operation,
	readJson,
	refreshSession,
} from "@suite/api-client";
import { randomUUID } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { endSession, type SignOut } from "./session";
import { backend, resilientFetch } from "./transport";

// EXPO_PUBLIC_ variables are inlined at build time. On an Android emulator the host
// machine is 10.0.2.2; on a physical device, use your computer's LAN address.
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000";

const client = new ApiClient({ baseUrl: API_URL, transport: resilientFetch(backend) });

export type Session = LoginResponse;
export type Feed = GetFeedResponse;
export type Post = CreatePostResponse;

const SESSION_KEY = "suite.session";

let session: Session | null = null;

/**
 * An unreadable keychain or a non-JSON entry signs the user out and deletes the entry, so
 * the next launch does not trip over it again.
 */
export async function restoreSession(): Promise<Session | null> {
	try {
		const raw = await SecureStore.getItemAsync(SESSION_KEY);

		session = raw ? (JSON.parse(raw) as Session) : null;
	} catch {
		session = null;
		// A keychain that cannot be read may refuse the delete too.
		await SecureStore.deleteItemAsync(SESSION_KEY).catch(() => undefined);
	}

	return session;
}

async function saveSession(next: Session | null): Promise<void> {
	session = next;

	if (next) await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(next));
	else await SecureStore.deleteItemAsync(SESSION_KEY);
}

export async function signIn(email: string, password: string): Promise<Session> {
	const next = await client.request(login({ email, password }));

	await saveSession(next);

	return next;
}

/** Rejects only when the keychain refuses the delete; the in-memory session is gone even then. */
export function signOut(): Promise<SignOut> {
	return endSession(client, session?.refreshToken, () => saveSession(null));
}

/**
 * The access token lives 15 minutes by default (lacewing caps it at an hour), so a 401 is routine:
 * trade the refresh token once and retry. A second 401 means the session is gone.
 */
async function asUser<T>(
	operation: Operation<T>,
	headers: Record<string, string> = {},
): Promise<T> {
	if (!session) throw new Error("Not signed in");

	const send = (s: Session) =>
		client.request(operation, {
			headers: { ...headers, authorization: `Bearer ${s.accessToken}` },
		});

	try {
		return await send(session);
	} catch (error) {
		if (!(error instanceof HttpError) || error.status !== 401) throw error;

		const renewed = await client
			.request(refreshSession({ refreshToken: session.refreshToken }))
			.catch(async (cause: unknown) => {
				await saveSession(null);
				throw cause;
			});
		await saveSession(renewed);

		return send(renewed);
	}
}

/** Public, so no token. */
export function loadFeed(): Promise<Feed> {
	return client.request(getFeed());
}

export interface Created {
	post: Post;
	/** The server replayed the first response instead of running the insert again. */
	replayed: boolean;
	idempotencyKey: string;
}

/**
 * One key per intent, minted before the first attempt and reused by every retry. The
 * header value is an RFC 8941 String, hence the quotes. The generated operation is a plain
 * object, so swapping `decode` to read one more header is a spread.
 */
export async function publish(input: CreatePostBody): Promise<Created> {
	const idempotencyKey = randomUUID();

	const operation: Operation<Omit<Created, "idempotencyKey">> = {
		...createPost(input),
		decode: async (response) => ({
			post: await readJson<Post>(response),
			replayed: response.headers.get("idempotent-replayed") === "true",
		}),
	};

	const result = await asUser(operation, { "idempotency-key": `"${idempotencyKey}"` });

	return { ...result, idempotencyKey };
}

export const backendHealth = () => backend.health();

/** Turns any failure into one line for the screen. HttpError carries the API's own body. */
export function describe(error: unknown): string {
	if (error instanceof HttpError) {
		try {
			const body = JSON.parse(error.body ?? "") as { message?: string; error?: string };

			return `${error.status}: ${body.message ?? body.error ?? error.statusText}`;
		} catch {
			return `${error.status}: ${error.statusText}`;
		}
	}

	return error instanceof Error ? error.message : String(error);
}
