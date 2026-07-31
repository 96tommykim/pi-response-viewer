import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { request } from "node:http";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assistantText, MAX_RESPONSE_BYTES, MAX_RESPONSES, responseHistory, ViewerState, type ViewerSnapshot } from "./state.ts";
import { SseClients, startViewerServer, type SseResponse, type ViewerServer } from "./server.ts";
import { createResponseViewer, openCommand, openOnce, openViewer, viewerEnabled, type ViewerDependencies } from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const textMessage = (text: string, stopReason?: string, errorMessage?: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage });

assert.equal(assistantText({ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "toolCall", name: "read" }, { type: "text", text: "visible" }] }), "visible");
const grouped = responseHistory([
	{ type: "message", id: "user-one", message: { role: "user", content: [{ type: "text", text: "must never leak" }] } },
	{ type: "message", message: textMessage("tool-intermediate") },
	{ type: "message", message: { role: "tool", content: [{ type: "text", text: "tool result must never leak" }] } },
	{ type: "message", message: textMessage("assistant-final") },
	{ type: "message", id: "user-two", message: { role: "user", content: [{ type: "text", text: "also hidden" }] } },
	{ type: "message", message: textMessage("next-final") },
	{ type: "message", message: textMessage("provider error text", "error") },
	{ type: "message", message: textMessage("aborted text", "aborted") },
]);
assert.deepEqual(grouped.map(response => [response.id, response.markdown]), [["user-one", "assistant-final"], ["user-two", "next-final"]]);
assert.doesNotMatch(JSON.stringify(grouped), /must never leak|tool result|provider error text|aborted text/);
assert.deepEqual(responseHistory([{ id: "assistant-before-user", message: textMessage("orphan") }, { id: "no-id", message: { role: "user", content: [] } }, { message: textMessage("visible") }]).map(response => [response.id, response.markdown]), [["restored-1", "orphan"], ["no-id", "visible"]]);
assert.deepEqual(responseHistory([{ message: { role: "user", content: [] } }, { message: textMessage("") }]), []);
assert.equal(viewerEnabled({ mode: "rpc" }), false);
assert.equal(openCommand("http://127.0.0.1/example")?.args.includes("http://127.0.0.1/example"), true);
const launches: string[] = [], browser = { opened: false };
assert.equal(openOnce(browser, "http://127.0.0.1/one", url => launches.push(url)), true);
assert.equal(openOnce(browser, "http://127.0.0.1/two", url => launches.push(url)), false);
assert.deepEqual(launches, ["http://127.0.0.1/one"]);

// ENOENT is emitted asynchronously by child_process.spawn. This mock would throw
// without the listener that openViewer attaches before unref().
const failedChild = new EventEmitter() as EventEmitter & { unref(): void };
let unrefed = false, errorRegistered = false;
const originalOnce = failedChild.once.bind(failedChild);
failedChild.once = ((event: string, listener: (...args: unknown[]) => void) => { if (event === "error") errorRegistered = true; return originalOnce(event, listener); }) as typeof failedChild.once;
failedChild.unref = () => { unrefed = true; };
openViewer("http://127.0.0.1/enoent", (() => {
	queueMicrotask(() => failedChild.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })));
	return failedChild;
}) as never);
await sleep(0);
assert.equal(unrefed, true);
assert.equal(errorRegistered, true, "the asynchronous ENOENT had an error listener");

class FakeResponse extends EventEmitter implements SseResponse {
	writableEnded = false;
	blocked = false;
	writes: string[] = [];
	write(chunk: string): boolean { this.writes.push(chunk); return !this.blocked; }
	end(chunk?: string): void { if (chunk) this.writes.push(chunk); this.writableEnded = true; this.emit("close"); }
}
const snapshot = (revision: number): ViewerSnapshot => ({ status: "running", responses: [{ id: `state-${revision}`, markdown: `state-${revision}`, status: "running", error: null, truncated: false }], latestId: `state-${revision}`, revision });
const pool = new SseClients(2);
const slow = new FakeResponse(); slow.blocked = true;
assert.equal(pool.add(slow, snapshot(1)), true);
pool.publish(snapshot(2)); pool.heartbeat(); pool.publish(snapshot(3));
assert.equal(slow.writes.length, 1, "blocked clients retain no unbounded writes");
slow.blocked = false; slow.emit("drain");
assert.equal(slow.writes.length, 2);
assert.match(slow.writes[1], /state-3/);
assert.doesNotMatch(slow.writes[1], /state-2/);
const second = new FakeResponse();
assert.equal(pool.add(second, snapshot(1)), true);
assert.equal(pool.add(new FakeResponse(), snapshot(1)), false, "SSE client cap applies before registration");
pool.close();
assert.equal(slow.writableEnded, true); assert.equal(second.writableEnded, true);
assert.equal(slow.listenerCount("drain"), 0); assert.equal(slow.listenerCount("close"), 0);
assert.equal(pool.size, 0, "close removes listeners and clients synchronously");
const finalPool = new SseClients(); const finalBlocked = new FakeResponse(); finalBlocked.blocked = true;
finalPool.add(finalBlocked, snapshot(1)); finalPool.publish({ ...snapshot(2), status: "closed" }); finalPool.close();
assert.match(finalBlocked.writes.at(-1)!, /"status":"closed"/, "a blocked client receives the final pending state through end()");

const historyState = new ViewerState();
historyState.restore(Array.from({ length: MAX_RESPONSES + 4 }, (_, index) => ({ id: `restored-${index}`, markdown: `response-${index}`, status: "complete" as const, error: null, truncated: false })));
assert.equal(historyState.snapshot().responses.length, MAX_RESPONSES);
assert.equal(historyState.snapshot().responses[0].id, "restored-4", "history drops the oldest items first");
const turnId = historyState.beginTurn(); const duplicateId = historyState.beginTurn();
assert.equal(duplicateId, turnId, "duplicate starts reuse an active high-level turn");
assert.equal(historyState.snapshot().responses.length, MAX_RESPONSES, "an empty turn does not evict history");
historyState.stream("live response"); historyState.settle();
assert.equal(historyState.snapshot().responses.at(-1)?.markdown, "live response");
historyState.beginTurn(); historyState.settle();
assert.equal(historyState.snapshot().responses.at(-1)?.markdown, "live response", "empty settled turns are invisible");
historyState.beginTurn(); historyState.fail(); historyState.settle("generic failure");
assert.equal(historyState.snapshot().responses.at(-1)?.markdown, "live response", "empty failed turns are invisible");
const oversized = "가".repeat(Math.ceil(MAX_RESPONSE_BYTES / 3) + 1);
const capState = new ViewerState(); capState.restore([{ id: "big", markdown: oversized, status: "complete", error: null, truncated: false }]);
const capped = capState.snapshot().responses[0];
assert.equal(Buffer.byteLength(capped.markdown, "utf8") <= MAX_RESPONSE_BYTES, true); assert.equal(Buffer.byteLength(capped.markdown, "utf8") + Buffer.byteLength("가", "utf8") > MAX_RESPONSE_BYTES, true);
assert.equal(capped.truncated, true); assert.equal(capped.markdown.includes("�"), false, "UTF-8 truncation does not split a code point");
capState.beginTurn(); capState.stream("retained latest"); capState.settle();
assert.deepEqual(capState.snapshot().responses.map(response => response.markdown), ["retained latest"], "byte bounds drop old responses before the newest");
const failedState = new ViewerState(); failedState.beginTurn(); failedState.stream("partial"); failedState.fail(); failedState.settle("generic failure");
assert.deepEqual(failedState.snapshot().responses.at(-1), { id: "live-1", markdown: "partial", status: "error", error: "generic failure", truncated: false });
const retryState = new ViewerState(); retryState.beginTurn(); retryState.stream("intermediate"); retryState.fail(); retryState.stream("retry-final"); retryState.settle("generic failure");
assert.deepEqual(retryState.snapshot().responses.map(response => [response.markdown, response.status, response.error]), [["retry-final", "complete", null]], "a retry after failure retains one successful response");

const state = new ViewerState(); state.restore([{ id: "previous", markdown: "previous", status: "complete", error: null, truncated: false }]); state.beginTurn(); state.stream("# current");
const viewer = await startViewerServer(here, () => state.snapshot());
const url = new URL(viewer.url);
type Result = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
const get = (path: string, method = "GET", host = url.host) => new Promise<Result>((resolve, reject) => {
	const req = request({ host: "127.0.0.1", port: url.port, path, method, headers: { Host: host } }, res => { let body = ""; res.setEncoding("utf8"); res.on("data", chunk => body += chunk); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body })); });
	req.on("error", reject); req.end();
});
const page = await get(url.pathname);
assert.equal(page.status, 200); assert.match(String(page.headers["content-security-policy"]), /default-src 'self'/); assert.equal(page.headers["cache-control"], "no-store, max-age=0"); assert.equal(page.headers["x-content-type-options"], "nosniff"); assert.equal(page.headers["access-control-allow-origin"], undefined);
assert.equal((await get(url.pathname, "GET", "localhost:1")).status, 404);
assert.equal((await get(`${url.pathname}renderer.js`)).status, 200, "renderer is served beneath the tokenized path");
const prismAssets = [
	["prism-core", "6caad316dd991f24f8004e0b9c19c055cb5829ff65e973fbee406f96d81b8e7e"], ["prism-markup", "879fc9d256c352d980e053857fa707330853b8bfb67ce284ea661a24dec5756e"], ["prism-clike", "c76ba4e240932bdc75546be30e550f5ba5e13815ff71511c76e9e27ac3072444"], ["prism-javascript", "0345ea83e12b7b974e953c79a64dea35a40308309449db70b82020fb688ac321"], ["prism-typescript", "852f5513bb9ca9db247f86ecfce74acc91c541749d34929157240518fef8152a"], ["prism-go", "1225b4afb593126d4082da5fd2b131aede39831c2b2a62d6b07ea025acd2bf3f"], ["prism-python", "ed4385685bcf2d4935c8dbbab4bde16603da1329e092d2bf36c3dadd67e9a85c"], ["prism-bash", "6260814110e5182f2956e3bd257429548d9dbf2a9b66a63719b26cf9fac966a7"], ["prism-yaml", "719c8e8b8c344dc9de510c729f65ba840b1502a0a8e7e25e2ad19ee715f65c02"], ["prism-json", "956d86baa5ae7ec4106758f354ac2d140bdcd7fc103dece02f73ed12b8d663e4"], ["prism-sql", "3fc5f8ce69950ec73adc972f061df42aaea78faa4864709134ea2adc083f3a33"], ["prism-hcl", "6c8bc9ea13f7ad08648eb2ffdda99d5ed674844220b2b4757aeb19d06fc78b18"], ["prism-docker", "a6cc0faa5977a40652f62798a692a5ae171e0380480df3ed056e117597ec52dd"], ["prism-markdown", "9f1166a087d9a9ffb3a833f2bccbe00920b55b41ade02a0b3054b7ab5fbc70ea"],
] as const;
for (const [name, hash] of prismAssets) { const asset = await get(`${url.pathname}vendor/${name}-1.30.0.min.js`); assert.equal(asset.status, 200, `${name} is tokenized and served`); assert.equal(asset.headers["content-type"], "text/javascript; charset=utf-8"); assert.equal(Number(asset.headers["content-length"]), Buffer.byteLength(asset.body)); assert.equal(createHash("sha256").update(asset.body).digest("hex"), hash); assert.equal((await get(`${url.pathname}vendor/${name}-1.30.0.min.js`, "POST")).status, 405); assert.equal((await get(`/wrong${url.pathname}vendor/${name}-1.30.0.min.js`)).status, 404); }
const syntax = await get(`${url.pathname}syntax.js`); assert.equal(syntax.status, 200); assert.equal(syntax.headers["content-type"], "text/javascript; charset=utf-8"); assert.equal((await get(`${url.pathname}syntax.js`, "POST")).status, 405);
const font = await get(`${url.pathname}vendor/PretendardVariable-1.3.9.woff2`); assert.equal(font.status, 200); assert.equal(font.headers["content-type"], "font/woff2"); assert.equal(Number(font.headers["content-length"]), 2_057_688);
assert.equal((await get(`${url.pathname}vendor/PretendardVariable-1.3.9.woff2`, "POST")).status, 405);
assert.equal((await get(`/wrong${url.pathname}vendor/PretendardVariable-1.3.9.woff2`)).status, 404);
assert.equal((await get(`${url.pathname}test-fixtures/renderer-security.html`)).status, 404, "browser security fixture is never served");
assert.equal((await get(`${url.pathname}nope`)).status, 404);
const wrongMethod = await get(url.pathname, "POST"); assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.headers.allow, "GET");
assert.equal((await get(`${url.pathname}events`, "POST")).status, 405);
const openStream = async () => new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
	const stream = request({ host: "127.0.0.1", port: url.port, path: `${url.pathname}events`, headers: { Host: url.host } });
	stream.once("response", resolve); stream.once("error", reject); stream.end();
});
const streams = await Promise.all(Array.from({ length: 8 }, openStream));
assert.equal((await get(`${url.pathname}events`)).status, 429, "server limits concurrent SSE clients");
const response = streams[0]; response.setEncoding("utf8"); let events = ""; response.on("data", chunk => events += chunk);
await sleep(20); assert.match(events, /"markdown":"# current"/); assert.match(events, /"markdown":"previous"/, "SSE publishes the full bounded response history");
state.stream("# final"); state.settle(); viewer.publish(state.snapshot(), true); await sleep(20); assert.match(events, /"markdown":"# final"/); assert.match(events, /"responses"/);
// Keep an idle TCP peer open: graceful SSE must still deliver closed before the
// bounded teardown force-destroys a connection that cannot finish naturally.
const stalled = connect(Number(url.port), "127.0.0.1"); await once(stalled, "connect"); stalled.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n");
const eof = once(response, "end"); state.close(); viewer.publish(state.snapshot(), true);
const closeStarted = performance.now(); const closing = viewer.close();
await Promise.race([closing, sleep(750).then(() => { throw new Error("viewer close hung"); })]); await eof;
assert.match(events, /"status":"closed"/, "normal SSE receives the terminal closed snapshot before EOF");
assert.equal(performance.now() - closeStarted < 500, true, "stalled peer teardown remained bounded");
await viewer.close(); stalled.destroy();
for (const stream of streams) stream.destroy();

const policySource = await readFile(join(here, "link-policy.js"), "utf8");
const policyWindow: { ResponseViewerLinkPolicy?: { allowedHref(value: unknown): { href: string; external: boolean } | null } } = {};
runInNewContext(policySource, { window: policyWindow, URL });
const allowedHref = policyWindow.ResponseViewerLinkPolicy!.allowedHref;
assert.equal(allowedHref("#heading")?.href, "#heading"); assert.equal(allowedHref("#heading")?.external, false);
assert.equal(allowedHref("https://example.test/path")?.href, "https://example.test/path"); assert.equal(allowedHref("https://example.test/path")?.external, true);
assert.equal(allowedHref("mailto:test@example.test")?.href, "mailto:test@example.test"); assert.equal(allowedHref("mailto:test@example.test")?.external, true);
for (const href of ["relative/path", "../relative", "/root", "//example.test", "javascript:alert(1)", "data:text/html,x", " ftp://example.test", " https://example.test"]) assert.equal(allowedHref(href), null, href);

const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
let viewerCommand: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
const mockPi = {
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, handler); },
	registerCommand(_name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) { viewerCommand = command; },
};
const fakeServers: Array<ViewerServer & { publishes: Array<{ snapshot: ViewerSnapshot; immediate: boolean }>; closes: number }> = [];
const lifecycleLaunches: string[] = [];
const dependencies: Partial<ViewerDependencies> = {
	directory: here,
	launchViewer: url => lifecycleLaunches.push(url),
	startServer: async (_directory, getState) => {
		const fake = {
			url: `http://127.0.0.1/fake-${fakeServers.length}`,
			publishes: [] as Array<{ snapshot: ViewerSnapshot; immediate: boolean }>,
			closes: 0,
			publish(next: ViewerSnapshot, immediate = false) { this.publishes.push({ snapshot: next, immediate }); },
			async close() { this.closes += 1; },
		};
		assert.equal(getState().status === "waiting" || getState().status === "complete", true);
		fakeServers.push(fake);
		return fake;
	},
};
createResponseViewer(mockPi as unknown as ExtensionAPI, dependencies);
const fire = async (event: string, payload: unknown, context: unknown) => { const handler = handlers.get(event); assert.ok(handler, `missing ${event}`); await handler(payload, context); };
let branch: unknown[] = [{ message: textMessage("restored") }];
const tuiContext = { mode: "tui", sessionManager: { getBranch: () => branch }, ui: { notify: () => undefined } };
const savedChild = process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_SUBAGENT_CHILD;
await fire("session_start", {}, tuiContext);
const latestResponse = (next: ViewerSnapshot) => next.responses.find(response => response.id === next.latestId);
assert.equal(fakeServers.length, 1); assert.equal(latestResponse(fakeServers[0].publishes.at(-1)!.snapshot)?.markdown, "restored");
await fire("before_agent_start", {}, tuiContext);
await fire("agent_start", {}, tuiContext); await fire("agent_start", {}, tuiContext);
assert.deepEqual(lifecycleLaunches, [fakeServers[0].url], "low-level retries open the browser only once and do not append a response");
await fire("message_update", { message: textMessage("tool-intermediate") }, tuiContext);
await fire("message_end", { message: { role: "tool", content: [{ type: "text", text: "tool data must not leak" }] } }, tuiContext);
await fire("message_end", { message: textMessage("assistant-final") }, tuiContext);
assert.equal(latestResponse(fakeServers[0].publishes.at(-1)!.snapshot)?.markdown, "assistant-final", "latest assistant text replaces intermediate tool-turn text");
assert.equal(latestResponse(fakeServers[0].publishes.at(-1)!.snapshot)?.status, "running", "assistant message_end does not finalize the high-level turn");
await fire("agent_settled", {}, tuiContext);
assert.equal(fakeServers[0].publishes.at(-1)!.snapshot.status, "complete");
await fire("before_agent_start", {}, tuiContext);
await fire("agent_start", {}, tuiContext);
await fire("message_update", { message: textMessage("safe partial") }, tuiContext);
await fire("message_end", { message: textMessage("provider details must not reach browser", "error", "provider secret") }, tuiContext);
await fire("agent_start", {}, tuiContext);
await fire("message_update", { message: textMessage("retry final") }, tuiContext);
await fire("agent_settled", {}, tuiContext);
assert.deepEqual(fakeServers[0].publishes.at(-1)!.snapshot.responses.slice(-2).map(response => [response.markdown, response.status]), [["assistant-final", "complete"], ["retry final", "complete"]], "retry remains one response in its original high-level turn");
assert.doesNotMatch(JSON.stringify(fakeServers[0].publishes.at(-1)!.snapshot), /provider details|provider secret|tool data must not leak/);
await fire("before_agent_start", {}, tuiContext);
await fire("agent_settled", {}, tuiContext);
assert.equal(fakeServers[0].publishes.at(-1)!.snapshot.responses.length, 3, "a second high-level boundary creates a distinct turn while an empty one remains invisible");
branch = [{ id: "tree-user", message: { role: "user", content: [{ type: "text", text: "hidden tree prompt" }] } }, { message: textMessage("tree-restored") }];
await fire("session_tree", {}, tuiContext);
assert.equal(latestResponse(fakeServers[0].publishes.at(-1)!.snapshot)?.markdown, "tree-restored");
assert.doesNotMatch(JSON.stringify(fakeServers[0].publishes.at(-1)!.snapshot), /hidden tree prompt/);
assert.equal(fakeServers[0].publishes.at(-1)!.immediate, true);
await viewerCommand!.handler("", tuiContext); assert.deepEqual(lifecycleLaunches, [fakeServers[0].url, fakeServers[0].url]);
await fire("session_start", {}, tuiContext);
assert.equal(fakeServers[0].closes, 1, "replacement start closes the old viewer"); assert.equal(fakeServers.length, 2);
await fire("agent_start", {}, tuiContext); assert.equal(lifecycleLaunches.length, 3, "replacement can open its new URL once");
await fire("session_shutdown", {}, tuiContext); assert.equal(fakeServers[1].closes, 1);

const disabledHandlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
const disabledPi = { on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { disabledHandlers.set(event, handler); }, registerCommand() {} };
let disabledStarts = 0, disabledLaunches = 0;
createResponseViewer(disabledPi as unknown as ExtensionAPI, { ...dependencies, startServer: async () => { disabledStarts += 1; throw new Error("must not start"); }, launchViewer: () => { disabledLaunches += 1; } });
await disabledHandlers.get("session_start")!({}, { ...tuiContext, mode: "rpc" }); await disabledHandlers.get("agent_start")!({}, { ...tuiContext, mode: "rpc" });
process.env.PI_SUBAGENT_CHILD = "1";
assert.equal(viewerEnabled(tuiContext), false);
await disabledHandlers.get("session_start")!({}, tuiContext); await disabledHandlers.get("agent_start")!({}, tuiContext);
assert.equal(disabledStarts, 0); assert.equal(disabledLaunches, 0, "non-TUI and child runs have no server or browser");
if (savedChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = savedChild;

const template = await readFile(join(here, "template.html"), "utf8");
const client = await readFile(join(here, "client.js"), "utf8");
const fontFile = await readFile(join(here, "vendor", "PretendardVariable-1.3.9.woff2"));
assert.equal(createHash("sha256").update(fontFile).digest("hex"), "9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4");
assert.doesNotMatch(template, /composer|static-raw/i); assert.doesNotMatch(template, /https?:\/\//i); assert.match(template, /vendor\/PretendardVariable-1\.3\.9\.woff2/); assert.match(template, /font-family:"Pretendard Variable"/); assert.doesNotMatch(template, /(?:code|pre|code-label)[^{]*\{[^}]*Jetendard/); assert.match(template, /--mono:ui-monospace/); assert.match(template, /--reader-size|--reader-leading|--reader-measure/); assert.match(template, /vendor\/marked-18\.0\.5\.umd\.js/); assert.match(template, /link-policy\.js/); assert.match(template, /renderer\.js/);
const syntaxSource = await readFile(join(here, "syntax.js"), "utf8"); const prismLicense = await readFile(join(here, "vendor", "LICENSE-prism.txt"), "utf8"); const notices = await readFile(join(here, "THIRD_PARTY_NOTICES.md"), "utf8");
assert.match(client, /events\.close\(\)/); assert.match(client, /ResponseViewerRenderer\.render/); assert.match(template, /New content available/); assert.match(client, /heading-link/); assert.match(client, /copy\(plain, copyButton\)/); assert.match(client, /replaceChildren\(window\.ResponseViewerSyntax\.highlight/); assert.match(template, /history-control/); assert.match(template, /previous-response/); assert.match(template, /assistant response history/); assert.match(template, /aria-label="Assistant response"/); assert.match(template, /response-header[^}]*scroll-margin-top:84px/); assert.match(client, /selectedId/); assert.match(client, /Reconnecting/); assert.match(client, /cadence = markdown/); assert.match(client, /selectedChanged && renderedId !== null\) clearHash/);
assert.match(syntaxSource, /Prism\.manual/); assert.match(syntaxSource, /ALLOWED_TAGS: \["span"\]/); assert.match(client, /codePreferences/); assert.match(client, /pruneCodePreferences\(responses\)/); assert.match(client, /codePreferences\.clear\(\)/); assert.match(template, /@media print/); assert.match(template, /@page/); assert.match(template, /vendor\/prism-core-1\.30\.0\.min\.js/); assert.match(template, /syntax\.js/); assert.match(prismLicense, /MIT LICENSE/i); for (const [name, hash] of prismAssets) { assert.match(notices, new RegExp(`${name}-1\\.30\\.0\\.min\\.js`)); assert.match(notices, new RegExp(hash)); } assert.doesNotMatch(`${template}\n${syntaxSource}`, /https?:\/\//, "production template and syntax helper contain no remote URL");
assert.match(template, /\.code-block,\.table-wrap \{ overflow:visible !important;[^}]*break-inside:auto/, "print allows long code and tables to paginate"); assert.match(template, /tr \{ break-inside:avoid/, "print avoids table-row breaks");
assert.match(client, /Math\.max\(margin \+ 2, toolbarClearance\)/, "scroll spy includes deterministic hash epsilon"); assert.match(client, /scrollIntoView\(\{ block: "start", behavior: "instant" \}\)/, "hash navigation bypasses CSS smooth scrolling"); assert.match(client, /outline\.scrollTop \+=/, "active item reveal only scrolls the outline list"); assert.match(template, /#outline-links \{ max-height:/, "outline links are the independent scroll container");
const closedCleanup = client.indexOf("if (nextSnapshot.status === \"closed\") { cleanup(); return; }");
assert.equal(closedCleanup > client.indexOf("const cleanup"), true, "closed snapshots synchronously close EventSource and remove scroll/hash work without another render");
console.log("PASS: response-viewer state, async spawn failure, bounded SSE, HTTP policy, links, lifecycle, shutdown, and template shell");
