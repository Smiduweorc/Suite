import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { createDatabase, pingDatabase } from "../index";

/**
 * A host that accepts the TCP connection and then never says anything: a database
 * behind a dead proxy, or a firewall that swallows packets. A refused connection fails
 * on its own; this one only fails if something is counting.
 */
async function silentHost(): Promise<{ port: number; server: Server; sockets: Socket[] }> {
	const sockets: Socket[] = [];
	const server = createServer((socket) => sockets.push(socket));

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

	const address = server.address();

	if (address === null || typeof address === "string") throw new Error("no port");

	return { port: address.port, server, sockets };
}

describe("database pool", () => {
	let cleanup: () => Promise<void> = async () => {};

	afterEach(() => cleanup());

	it("gives up on a host that never answers instead of waiting forever", async () => {
		const host = await silentHost();
		const { db, pool } = createDatabase(`postgres://nobody:x@127.0.0.1:${host.port}/nope`);

		cleanup = async () => {
			for (const socket of host.sockets) socket.destroy();
			await new Promise((resolve) => host.server.close(resolve));
			await pool.end().catch(() => undefined);
		};

		const startedAt = performance.now();

		await expect(pingDatabase(db)).rejects.toThrow();
		// connectionTimeoutMillis is 3s; without it this never settles.
		expect(performance.now() - startedAt).toBeLessThan(4_500);
	}, 10_000);
});
