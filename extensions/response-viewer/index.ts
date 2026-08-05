import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assistantText, responseHistory, ViewerState, type ViewerSnapshot } from "./state.ts";
import { startViewerServer, type ViewerServer } from "./server.ts";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const SAFE_FAILURE_MESSAGE = "The response ended with an error. See the terminal for details.";

type ModeContext = { mode?: unknown; sessionManager?: { getBranch?: () => Iterable<unknown> }; ui?: { notify?: (text: string, level?: "info" | "warning" | "error") => void } };
type SpawnProcess = (command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => ChildProcess;
export type ViewerDependencies = {
	startServer: (directory: string, getState: () => ViewerSnapshot) => Promise<ViewerServer>;
	launchViewer: (url: string) => void;
	directory: string;
};

export function viewerEnabled(ctx: ModeContext): boolean { return ctx.mode === "tui" && process.env.PI_SUBAGENT_CHILD !== "1"; }
export function openCommand(url: string): { command: string; args: string[] } | null {
	if (process.platform === "darwin") return { command: "open", args: [url] };
	if (process.platform === "linux") return { command: "xdg-open", args: [url] };
	if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
	return null;
}
/** A spawn error is asynchronous on ENOENT, so subscribe before unref(). */
export function openViewer(url: string, spawnProcess: SpawnProcess = spawn): void {
	const command = openCommand(url);
	if (!command) return;
	try {
		const child = spawnProcess(command.command, command.args, { detached: true, stdio: "ignore" });
		child.once("error", () => undefined);
		child.unref();
	} catch { /* Browser availability must not affect Pi. */ }
}
/** Kept separate so lifecycle behavior is testable without launching a browser. */
export function openOnce(state: { opened: boolean }, url: string, launch: (url: string) => void = openViewer): boolean {
	if (state.opened) return false;
	state.opened = true;
	launch(url);
	return true;
}

export function createResponseViewer(pi: ExtensionAPI, supplied: Partial<ViewerDependencies> = {}): void {
	const dependencies: ViewerDependencies = { startServer: startViewerServer, launchViewer: openViewer, directory: extensionDirectory, ...supplied };
	const state = new ViewerState();
	let server: ViewerServer | undefined;
	const browser = { opened: false };
	let enabled = false;
	const publish = (immediate = false) => server?.publish(state.snapshot(), immediate);
	const close = async () => {
		state.close();
		publish(true);
		const current = server;
		server = undefined;
		if (current) await current.close().catch(() => undefined);
	};
	const restore = (ctx: ModeContext) => {
		const history = ctx.sessionManager?.getBranch?.();
		state.restore(history ? responseHistory(history) : []);
		publish(true);
	};
	const start = async (ctx: ModeContext) => {
		enabled = viewerEnabled(ctx);
		browser.opened = false;
		if (!enabled) return;
		const history = ctx.sessionManager?.getBranch?.();
		state.restore(history ? responseHistory(history) : []);
		try {
			server = await dependencies.startServer(dependencies.directory, () => state.snapshot());
			publish(true);
		} catch { ctx.ui?.notify?.("Response viewer could not start; terminal output remains available.", "warning"); }
	};

	pi.registerCommand("viewer", {
		description: "Open the response viewer (on|off to enable or disable)",
		handler: async (args, ctx) => {
			const token = args.trim().split(/\s+/)[0].toLowerCase();
			if (token === "off") {
				enabled = false;
				await close();
				ctx.ui?.notify?.("Response viewer disabled for this session.", "info");
				return;
			}
			if (token === "on" || token === "") {
				if (!viewerEnabled(ctx)) { ctx.ui?.notify?.("Response viewer is unavailable for this session.", "warning"); return; }
				const running = server;
				if (running) { dependencies.launchViewer(running.url); return; }
				await start(ctx);
				if (server) dependencies.launchViewer(server.url);
				return;
			}
			ctx.ui?.notify?.("Usage: /viewer [on|off]", "warning");
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		await close(); // Defensive for reload-like test and host lifecycles that reissue start.
		await start(ctx);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		if (!enabled || !viewerEnabled(ctx)) return;
		state.beginTurn();
	});
	pi.on("agent_start", (_event, ctx) => {
		if (!enabled || !viewerEnabled(ctx)) return;
		if (server) openOnce(browser, server.url, dependencies.launchViewer);
	});
	pi.on("message_update", (event) => {
		if (!enabled) return;
		const text = assistantText(event.message);
		if (text.trim()) { state.stream(text); publish(false); }
	});
	pi.on("message_end", (event) => {
		if (!enabled) return;
		const message = event.message as { role?: unknown; content?: unknown; stopReason?: unknown };
		const text = assistantText(message);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			state.fail();
			return;
		}
		if (!text.trim()) return;
		state.stream(text);
		publish(false);
	});
	pi.on("agent_settled", () => { if (enabled) { state.settle(SAFE_FAILURE_MESSAGE); publish(true); } });
	pi.on("session_tree", (_event, ctx) => { if (enabled) restore(ctx); });
	pi.on("session_shutdown", async () => { enabled = false; await close(); });
}

export default function (pi: ExtensionAPI): void { createResponseViewer(pi); }
