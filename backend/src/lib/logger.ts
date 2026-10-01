import { randomUUID } from "node:crypto";
import pino, { type Logger } from "pino";
import { env } from "../config/env";

export type { Logger };

/**
 * A safety net: pino redacts only these paths, so `log.info({ user })` with a new
 * secret-bearing field would still spill. Log ids, not objects.
 */
const REDACT = [
	"password",
	"*.password",
	"passwordHash",
	"*.passwordHash",
	"token",
	"*.token",
	"accessToken",
	"*.accessToken",
	"refreshToken",
	"*.refreshToken",
	"authorization",
	"*.authorization",
	"cookie",
	"*.cookie",
	"headers.authorization",
	"headers.cookie",
];

/** NDJSON on stdout. pino-pretty costs a worker thread, so development only. */
export const logger: Logger = pino({
	level: env.LOG_LEVEL,
	base: { service: env.SERVICE_NAME, env: env.NODE_ENV },
	redact: { paths: REDACT, censor: "[redacted]" },
	...(env.NODE_ENV === "development"
		? {
				transport: {
					target: "pino-pretty",
					options: {
						colorize: true,
						translateTime: "HH:MM:ss.l",
						ignore: "pid,hostname,service,env",
					},
				},
			}
		: {}),
});

/**
 * An inbound `x-request-id` is reused, so a trace survives the hop from a gateway. Capped
 * because it is attacker-supplied and ends up in log storage.
 */
export function requestIdFrom(inbound: string | null | undefined): string {
	if (inbound && inbound.length > 0 && inbound.length <= 200) {
		return inbound;
	}

	return randomUUID();
}

const assigned = new WeakMap<Request, string>();

/**
 * Minted at most once per Request: Elysia's hooks and the /api/v1 routes share the Request
 * object, and each minting its own would log and echo different ids.
 */
export function requestIdOf(request: Request): string {
	let id = assigned.get(request);

	if (id === undefined) {
		id = requestIdFrom(request.headers.get("x-request-id"));
		assigned.set(request, id);
	}

	return id;
}
