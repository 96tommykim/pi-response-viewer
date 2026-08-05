import { createServer, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Socket } from "node:net";
import type { ViewerSnapshot } from "./state.ts";

const MAX_CLIENTS = 8;
const HEARTBEAT_MS = 20_000;
const headers = {
	"Cache-Control": "no-store, max-age=0",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Content-Security-Policy": "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; img-src 'none'; media-src 'none'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'none'",
};

export type ViewerServer = Readonly<{ url: string; publish(snapshot: ViewerSnapshot, immediate?: boolean): void; close(): Promise<void> }>;

export interface SseResponse {
	writableEnded: boolean;
	write(chunk: string): boolean;
	end(chunk?: string): void;
	on(event: "drain" | "close", listener: () => void): unknown;
	removeListener(event: "drain" | "close", listener: () => void): unknown;
}

type Client = { response: SseResponse; blocked: boolean; pending: string | undefined; onDrain: () => void; onClose: () => void };
const stateEvent = (snapshot: ViewerSnapshot) => `event: state\ndata: ${JSON.stringify(snapshot)}\n\n`;

/** Bounded SSE fan-out: a blocked client retains only its newest state event. */
export class SseClients {
	private readonly clients = new Set<Client>();
	private readonly maxClients: number;
	constructor(maxClients = MAX_CLIENTS) { this.maxClients = maxClients; }
	get size(): number { return this.clients.size; }

	add(response: SseResponse, snapshot: ViewerSnapshot): boolean {
		if (this.clients.size >= this.maxClients) return false;
		const client = {} as Client;
		client.response = response;
		client.blocked = false;
		client.pending = undefined;
		client.onDrain = () => this.drain(client);
		client.onClose = () => this.remove(client);
		this.clients.add(client);
		response.on("drain", client.onDrain);
		response.on("close", client.onClose);
		this.send(client, stateEvent(snapshot));
		return true;
	}

	publish(snapshot: ViewerSnapshot): void {
		const event = stateEvent(snapshot);
		for (const client of this.clients) this.send(client, event);
	}

	heartbeat(): void {
		for (const client of this.clients) {
			// Heartbeats have no value after a blocked response; never queue them.
			if (!client.blocked && !client.response.writableEnded && !client.response.write(": heartbeat\n\n")) client.blocked = true;
		}
	}

	close(): void {
		for (const client of [...this.clients]) {
			// A false write has already been accepted by Node; only a newer bounded
			// pending event needs to be supplied to end() for a graceful final flush.
			const pending = client.pending;
			this.remove(client);
			if (!client.response.writableEnded) client.response.end(pending);
		}
	}

	private send(client: Client, event: string): void {
		if (client.response.writableEnded) { this.remove(client); return; }
		if (client.blocked) { client.pending = event; return; }
		if (!client.response.write(event)) client.blocked = true;
	}

	private drain(client: Client): void {
		if (!this.clients.has(client) || client.response.writableEnded) { this.remove(client); return; }
		client.blocked = false;
		const pending = client.pending;
		client.pending = undefined;
		if (pending) this.send(client, pending);
	}

	private remove(client: Client): void {
		if (!this.clients.delete(client)) return;
		client.pending = undefined;
		client.response.removeListener("drain", client.onDrain);
		client.response.removeListener("close", client.onClose);
	}
}

export async function startViewerServer(directory: string, getState: () => ViewerSnapshot): Promise<ViewerServer> {
	const token = randomBytes(32).toString("base64url");
	const base = `/${token}`;
	const template = await readFile(join(directory, "template.html"));
	const assets = new Map<string, { body: Buffer; type: string }>([
		["/", { body: template, type: "text/html; charset=utf-8" }],
		["/client.js", { body: await readFile(join(directory, "client.js")), type: "text/javascript; charset=utf-8" }],
		["/link-policy.js", { body: await readFile(join(directory, "link-policy.js")), type: "text/javascript; charset=utf-8" }],
		["/renderer.js", { body: await readFile(join(directory, "renderer.js")), type: "text/javascript; charset=utf-8" }],
		["/syntax.js", { body: await readFile(join(directory, "syntax.js")), type: "text/javascript; charset=utf-8" }],
		["/mermaid-view.js", { body: await readFile(join(directory, "mermaid-view.js")), type: "text/javascript; charset=utf-8" }],
		["/tree-view.js", { body: await readFile(join(directory, "tree-view.js")), type: "text/javascript; charset=utf-8" }],
		...await Promise.all(["prism-core", "prism-markup", "prism-clike", "prism-javascript", "prism-typescript", "prism-go", "prism-python", "prism-bash", "prism-yaml", "prism-json", "prism-sql", "prism-hcl", "prism-docker", "prism-markdown"].map(async name => [`/vendor/${name}-1.30.0.min.js`, { body: await readFile(join(directory, "vendor", `${name}-1.30.0.min.js`)), type: "text/javascript; charset=utf-8" }] as const)),
		["/vendor/marked-18.0.5.umd.js", { body: await readFile(join(directory, "vendor/marked-18.0.5.umd.js")), type: "text/javascript; charset=utf-8" }],
		["/vendor/dompurify-3.4.12.min.js", { body: await readFile(join(directory, "vendor/dompurify-3.4.12.min.js")), type: "text/javascript; charset=utf-8" }],
		["/vendor/mermaid-11.16.1.min.js", { body: await readFile(join(directory, "vendor/mermaid-11.16.1.min.js")), type: "text/javascript; charset=utf-8" }],
	]);
	const clients = new SseClients();
	const sockets = new Set<Socket>();
	let server: Server | undefined;
	let closed = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let pending: ReturnType<typeof setTimeout> | undefined;
	let last: ViewerSnapshot = getState();
	let port = 0;

	const broadcast = (snapshot: ViewerSnapshot) => clients.publish(snapshot);
	const publishNow = () => { pending = undefined; broadcast(last); };
	const notFound = (response: ServerResponse) => response.writeHead(404, headers).end();
	const requestHandler = (request: import("node:http").IncomingMessage, response: ServerResponse) => {
		const host = request.headers.host;
		if (host !== `127.0.0.1:${port}` || !request.url) { notFound(response); return; }
		let pathname: string;
		try { pathname = new URL(request.url, `http://${host}`).pathname; } catch { notFound(response); return; }
		if (!pathname.startsWith(`${base}/`)) { notFound(response); return; }
		if (request.method !== "GET") { response.writeHead(405, { ...headers, Allow: "GET" }).end(); return; }
		const subpath = pathname.slice(base.length) || "/";
		if (subpath === "/events") {
			if (clients.size >= MAX_CLIENTS) { response.writeHead(429, headers).end(); return; }
			response.writeHead(200, { ...headers, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive" });
			clients.add(response, last);
			return;
		}
		const asset = assets.get(subpath);
		if (!asset) { notFound(response); return; }
		response.writeHead(200, { ...headers, "Content-Type": asset.type, "Content-Length": asset.body.length });
		response.end(asset.body);
	};
	server = createServer(requestHandler);
	server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
	await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", () => { server!.off("error", reject); resolve(); }); });
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("viewer did not receive a loopback port");
	port = address.port;
	timer = setInterval(() => clients.heartbeat(), HEARTBEAT_MS);
	return {
		url: `http://127.0.0.1:${port}${base}/`,
		publish(snapshot, immediate = false) { if (closed) return; last = snapshot; if (immediate) { if (pending) clearTimeout(pending); publishNow(); } else if (!pending) pending = setTimeout(publishNow, 80); },
		async close() {
			if (closed) return;
			closed = true;
			if (pending) clearTimeout(pending);
			if (timer) clearInterval(timer);
			clients.close();
			// Give end() a short opportunity to flush the terminal snapshot. A peer
			// that never closes is forcibly released after the bounded grace period.
			const stopped = new Promise<void>((resolve) => server!.close(() => resolve()));
			let forceTimer: ReturnType<typeof setTimeout> | undefined;
			const forced = await new Promise<boolean>(resolve => {
				forceTimer = setTimeout(() => resolve(true), 250);
				stopped.then(() => resolve(false));
			});
			if (forceTimer) clearTimeout(forceTimer);
			if (forced) for (const socket of sockets) socket.destroy();
			await stopped;
		},
	};
}
