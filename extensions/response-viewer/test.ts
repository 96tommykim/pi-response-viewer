import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { request } from "node:http";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assistantText, closeOpenFence, contentSegments, findToolStep, MAX_RESPONSE_BYTES, MAX_RESPONSES, messageText, parseToolStep, PROMPT_BYTES, responseHistory, SEGMENT_SEPARATOR, summarizeArguments, THINKING_BYTES, thinkingSegment, toolStepSegment, ViewerState, type ViewerSnapshot } from "./state.ts";
import { SseClients, startViewerServer, type SseResponse, type ViewerServer } from "./server.ts";
import { createResponseViewer, openCommand, openOnce, openViewer, viewerEnabled, type ViewerDependencies } from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const textMessage = (text: string, stopReason?: string, errorMessage?: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage });

assert.equal(assistantText({ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "toolCall", name: "read" }, { type: "text", text: "visible" }] }), "visible");
const restoreNonce = "restore-nonce";
const grouped = responseHistory([
	{ type: "message", id: "user-one", message: { role: "user", content: [{ type: "text", text: "first question" }] } },
	{ type: "message", message: textMessage("tool-intermediate") },
	{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "Read", arguments: { file_path: "a.ts" } }] } },
	{ type: "message", message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "file body" }], isError: false } },
	{ type: "message", message: textMessage("assistant-final") },
	{ type: "message", id: "user-two", message: { role: "user", content: [{ type: "text", text: "second question" }] } },
	{ type: "message", message: textMessage("next-final") },
	{ type: "message", message: textMessage("provider error text", "error") },
	{ type: "message", message: textMessage("aborted text", "aborted") },
	{ type: "modelChange", model: "some-model" },
], restoreNonce);
assert.equal(grouped.length, 2, "one response per user turn");
assert.equal(grouped[0].prompt?.text, "first question", "restored responses carry their prompt");
assert.equal(grouped[1].prompt?.text, "second question");
const restoredStep = grouped[0].markdown.split(SEGMENT_SEPARATOR).map(segment => parseToolStep(segment, restoreNonce)).find(Boolean);
assert.equal(restoredStep?.status, "ok", "a restored tool step is matched with its result");
assert.equal(restoredStep?.result, "file body");
assert.match(grouped[0].markdown, /assistant-final/);
assert.doesNotMatch(grouped[1].markdown, /provider error text|aborted text/, "failed messages stay out of history");

// A restored toolResult whose id matches nothing pending must be skipped without throwing, and an
// isError result must close the step as "error" (not left "running") with its text attached.
const unmatchedRestore = responseHistory([
	{ type: "message", id: "user-unmatched", message: { role: "user", content: [{ type: "text", text: "q" }] } },
	{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "real-call", name: "Bash", arguments: { command: "npm test" } }] } },
	{ type: "message", message: { role: "toolResult", toolCallId: "no-such-call", content: [{ type: "text", text: "orphan result" }], isError: false } },
	{ type: "message", message: { role: "toolResult", toolCallId: "real-call", content: [{ type: "text", text: "test failed" }], isError: true } },
], restoreNonce);
assert.doesNotThrow(() => responseHistory([
	{ type: "message", message: { role: "toolResult", toolCallId: "no-such-call", content: [{ type: "text", text: "orphan" }], isError: false } },
], restoreNonce), "an unmatched restored toolResult is skipped, not thrown on");
const unmatchedStep = unmatchedRestore[0].markdown.split(SEGMENT_SEPARATOR).map(segment => parseToolStep(segment, restoreNonce)).find(Boolean);
assert.equal(unmatchedStep?.status, "error", "a restored isError result closes the step as error, not running");
assert.equal(unmatchedStep?.result, "test failed");
assert.doesNotMatch(JSON.stringify(unmatchedRestore), /orphan result/, "a toolResult matching no pending step attaches nowhere");

// A restored branch whose last assistant message opens a toolCall with no matching toolResult (an
// interrupted session, entirely ordinary for a coding agent) must not restore as a spinner inside a
// response stamped "complete" — the running step is closed to "error"/"Interrupted." on restore too.
const orphanedRestore = responseHistory([
	{ type: "message", id: "user-orphan", message: { role: "user", content: [{ type: "text", text: "q" }] } },
	{ type: "message", message: textMessage("looking now") },
	{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "orphan-call", name: "Bash", arguments: { command: "long job" } }] } },
], restoreNonce);
assert.equal(orphanedRestore[0].status, "complete", "a restored turn is never left in a non-terminal status");
const orphanedStep = orphanedRestore[0].markdown.split(SEGMENT_SEPARATOR).map(segment => parseToolStep(segment, restoreNonce)).find(Boolean);
assert.equal(orphanedStep?.status, "error", "a step still running when the branch ends is closed as an error on restore");
assert.equal(orphanedStep?.result, "Interrupted.");

// Two toolResult entries for the same toolCallId: the first delivery wins, exactly as completeStep
// does live — the restore path must not be last-write-wins while the live path is first-write-wins.
const duplicateRestore = responseHistory([
	{ type: "message", id: "user-dup", message: { role: "user", content: [{ type: "text", text: "q" }] } },
	{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "dup-call", name: "Bash", arguments: { command: "npm test" } }] } },
	{ type: "message", message: { role: "toolResult", toolCallId: "dup-call", content: [{ type: "text", text: "first result" }], isError: false } },
	{ type: "message", message: { role: "toolResult", toolCallId: "dup-call", content: [{ type: "text", text: "second result" }], isError: true } },
], restoreNonce);
const duplicateStep = duplicateRestore[0].markdown.split(SEGMENT_SEPARATOR).map(segment => parseToolStep(segment, restoreNonce)).find(Boolean);
assert.equal(duplicateStep?.status, "ok", "the first delivered toolResult wins on restore");
assert.equal(duplicateStep?.result, "first result");

// The ordering trap: closing an orphaned step must run BEFORE `newest` is read in flush(), or closing
// the step that happens to be the LAST segment leaves `newest` holding a stale (still-"running") copy
// that fitSegments then re-appends. A fixture that only orphans a middle segment would not catch this.
const orphanedLastRestore = responseHistory([
	{ type: "message", id: "user-orphan-last", message: { role: "user", content: [{ type: "text", text: "q" }] } },
	{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "trailing-call", name: "Bash", arguments: { command: "still running" } }] } },
], restoreNonce);
const trailingSegments = orphanedLastRestore[0].markdown.split(SEGMENT_SEPARATOR);
assert.equal(trailingSegments.length, 1, "the orphaned step is the only, and last, segment");
const trailingStep = parseToolStep(trailingSegments.at(-1), restoreNonce);
assert.equal(trailingStep?.status, "error", "an orphaned step that is the last segment is still closed, not left running");
assert.equal(trailingStep?.result, "Interrupted.");

// The restored and live paths share one converter; the same message sequence must produce identical
// markdown through both. Same nonce on both sides isolates the comparison to segment content/order.
// Covers all three segment kinds: thinking, text, and a tool step with its result.
const equivEntries = [
	{ role: "assistant", content: [{ type: "thinking", thinking: "considering the request" }, { type: "text", text: "tool-intermediate" }] },
	{ role: "assistant", content: [{ type: "toolCall", id: "eq-1", name: "Read", arguments: { file_path: "a.ts" } }] },
	{ role: "toolResult", toolCallId: "eq-1", content: [{ type: "text", text: "file body" }], isError: false },
	{ role: "assistant", content: [{ type: "text", text: "assistant-final" }] },
];
const liveEquivState = new ViewerState();
liveEquivState.beginTurn();
for (const message of equivEntries) {
	if (message.role === "toolResult") liveEquivState.completeStep(message.toolCallId as string, messageText(message), message.isError === true);
	else liveEquivState.commitMessage(message);
}
liveEquivState.settle();
const liveEquivMarkdown = liveEquivState.snapshot().responses.at(-1)!.markdown;
const restoredEquiv = responseHistory([
	{ type: "message", id: "equiv-user", message: { role: "user", content: [] } },
	...equivEntries.map(message => ({ type: "message", message })),
], liveEquivState.nonce);
assert.equal(restoredEquiv[0].markdown, liveEquivMarkdown, "restored and live paths converge on the same markdown for the same message sequence");

// --- turn context: pure conversion ---
const NONCE = "test-nonce";
assert.equal(summarizeArguments({ command: "npm  test\n--silent" }), "npm test --silent", "command wins and whitespace collapses");
assert.equal(summarizeArguments({ file_path: "a/b.ts", command: "ls" }), "ls", "key precedence is command before file_path");
assert.equal(summarizeArguments({ pattern: "foo" }), "foo");
assert.equal(summarizeArguments({ weird: 3 }), '{"weird":3}', "unknown shapes fall back to JSON");
assert.equal(summarizeArguments(undefined), "{}");
assert.equal(summarizeArguments({ command: "x".repeat(200) }), `${"x".repeat(120)}…`, "summary is cut at SUMMARY_CHARS");

const stepSegment = toolStepSegment(NONCE, { id: "call-1", name: "Read", summary: "a.ts", status: "running", result: "", truncated: false });
assert.equal(stepSegment.split("\n").length, 3, "fence payload is a single line");
assert.deepEqual(parseToolStep(stepSegment, NONCE), { id: "call-1", name: "Read", summary: "a.ts", status: "running", result: "", truncated: false });
assert.equal(parseToolStep(stepSegment, "other-nonce"), null, "a foreign nonce does not parse");
assert.equal(parseToolStep("```pi-tool\nnot json\n```", NONCE), null, "malformed payload does not parse");

const backtickStep = toolStepSegment(NONCE, { id: "b1", name: "Bash", summary: "echo", status: "ok", result: "```\nrm -rf /\n```", truncated: false });
assert.equal(closeOpenFence(backtickStep), backtickStep, "a result containing fences does not leave the segment open");

const converted = contentSegments({
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "reasoning" },
		{ type: "text", text: "answer" },
		{ type: "toolCall", id: "call-1", name: "Read", arguments: { file_path: "a.ts" } },
	],
}, NONCE);
assert.equal(converted.length, 3, "each content block becomes one segment, in source order");
assert.match(converted[0], /^```pi-think\n/);
assert.equal(converted[1], "answer");
assert.equal(parseToolStep(converted[2], NONCE)?.summary, "a.ts");
assert.equal(parseToolStep(converted[2], NONCE)?.id, "call-1", "the tool-call id travels in the payload");
assert.deepEqual(contentSegments({ role: "assistant", content: [{ type: "text", text: "   " }] }, NONCE), [], "blank text produces no segment");
assert.deepEqual(contentSegments(undefined, NONCE), [], "a missing message produces no segment");

// A step is located by id, never by a stored index — fitSegments shifts the array out from under one.
const stepList = [contentSegments({ role: "assistant", content: [{ type: "toolCall", id: "a", name: "Read", arguments: {} }] }, NONCE)[0], "prose", contentSegments({ role: "assistant", content: [{ type: "toolCall", id: "b", name: "Bash", arguments: {} }] }, NONCE)[0]];
assert.equal(findToolStep(stepList, "a", NONCE), 0);
assert.equal(findToolStep(stepList, "b", NONCE), 2);
assert.equal(findToolStep(stepList, "missing", NONCE), -1);
assert.equal(findToolStep(stepList, "a", "other-nonce"), -1, "a foreign nonce finds nothing");
assert.equal(findToolStep(stepList.slice(1), "a", NONCE), -1, "a dropped segment is simply not found");
assert.equal(parseToolStep(undefined, NONCE), null, "a missing segment does not throw");

const longThinking = thinkingSegment(NONCE, "t".repeat(THINKING_BYTES + 500));
assert.equal(JSON.parse(longThinking.split("\n")[1]).truncated, true, "thinking over the cap is flagged");
assert.equal(JSON.parse(longThinking.split("\n")[1]).thinking.length, THINKING_BYTES, "thinking is cut at THINKING_BYTES");

assert.equal(messageText({ role: "toolResult", content: [{ type: "text", text: "out" }, { type: "image" }] }), "out");
assert.equal(messageText({ role: "toolResult" }), "");
// UserMessage.content is `string | (TextContent | ImageContent)[]`; the bare-string form is real.
assert.equal(messageText({ role: "user", content: "a plain string prompt" }), "a plain string prompt");
assert.equal(messageText({ role: "user", content: "" }), "");

// --- turn context: state wiring ---
const contextState = new ViewerState();
assert.match(contextState.nonce, /^[\w-]{16,}$/, "each state gets an unguessable nonce");
assert.equal(contextState.snapshot().nonce, contextState.nonce, "the nonce reaches the client through the snapshot");

contextState.beginTurn();
contextState.setPrompt("check the segment model");
contextState.stream("looking now");
contextState.commitMessage({ role: "assistant", content: [
	{ type: "text", text: "looking now" },
	{ type: "toolCall", id: "call-1", name: "Read", arguments: { file_path: "state.ts" } },
] });
let live = contextState.snapshot().responses.at(-1)!;
assert.equal(live.prompt?.text, "check the segment model");
assert.equal(live.markdown.split(SEGMENT_SEPARATOR).length, 2, "text and tool step are separate segments");
assert.equal(parseToolStep(live.markdown.split(SEGMENT_SEPARATOR)[1], contextState.nonce)?.status, "running");

assert.equal(contextState.completeStep("call-1", "file contents", false), true);
live = contextState.snapshot().responses.at(-1)!;
const step = parseToolStep(live.markdown.split(SEGMENT_SEPARATOR)[1], contextState.nonce);
assert.equal(step?.status, "ok");
assert.equal(step?.result, "file contents");
assert.equal(live.markdown.split(SEGMENT_SEPARATOR)[0], "looking now", "other segments are untouched");
assert.equal(contextState.completeStep("call-missing", "x", false), false, "an unknown tool call id is ignored");

contextState.commitMessage({ role: "assistant", content: [
	{ type: "toolCall", id: "call-2", name: "Bash", arguments: { command: "npm test" } },
] });
contextState.settle("failed");
const settled = contextState.snapshot().responses.at(-1)!;
const abandoned = settled.markdown.split(SEGMENT_SEPARATOR).map(segment => parseToolStep(segment, contextState.nonce)).filter(Boolean);
assert.equal(abandoned.at(-1)?.status, "error", "a step still running when the turn ends is closed as an error");
assert.equal(abandoned.at(-1)?.result, "Interrupted.");

const promptState = new ViewerState();
promptState.beginTurn();
promptState.setPrompt("p".repeat(PROMPT_BYTES + 100));
promptState.stream("body");
assert.equal(promptState.snapshot().responses.at(-1)?.prompt?.truncated, true, "an oversized prompt is truncated and flagged");
assert.equal(promptState.snapshot().responses.at(-1)?.prompt?.text.length, PROMPT_BYTES);

// A failed message must still drop its partial text so a retry does not double it.
const retryDiscardState = new ViewerState();
retryDiscardState.beginTurn(); retryDiscardState.stream("partial"); retryDiscardState.fail(); retryDiscardState.stream("retried"); retryDiscardState.settle();
assert.equal(retryDiscardState.snapshot().responses.at(-1)?.markdown, "retried", "fail() still discards the partial message");

assert.equal(MAX_RESPONSE_BYTES, 4 * 1024 * 1024, "the byte budget accounts for tool results");

// settle() now always rebuilds the markdown; it must still respect the byte cap.
const budgetState = new ViewerState();
budgetState.beginTurn();
budgetState.stream("first");
budgetState.commitMessage({ role: "assistant", content: [{ type: "text", text: "x".repeat(MAX_RESPONSE_BYTES) }] });
budgetState.commitMessage({ role: "assistant", content: [{ type: "text", text: "last message" }] });
budgetState.settle();
const bounded = budgetState.snapshot().responses.at(-1)!;
assert.ok(Buffer.byteLength(bounded.markdown, "utf8") <= MAX_RESPONSE_BYTES, "settle does not resurrect budget-dropped segments");
assert.equal(bounded.truncated, true, "dropping segments stays flagged through settle");
assert.match(bounded.markdown, /last message/);

// Regression: a tracked step's segment can be shifted out of `active.done` by a later budget drop
// (`fitSegments` mutates the array with `older.shift()`). completeStep and settle must never crash
// scanning for it afterward; a step whose segment was dropped simply cannot be completed anymore.
const survivalState = new ViewerState();
survivalState.beginTurn();
survivalState.commitMessage({ role: "assistant", content: [{ type: "toolCall", id: "call-drop", name: "Bash", arguments: { command: "long job" } }] });
survivalState.commitMessage({ role: "assistant", content: [{ type: "text", text: "x".repeat(MAX_RESPONSE_BYTES) }] });
let completed: boolean | undefined;
assert.doesNotThrow(() => { completed = survivalState.completeStep("call-drop", "done", false); }, "completeStep must not throw when its segment was dropped by the byte cap");
assert.equal(completed, false, "a step whose segment the budget already dropped cannot be completed");
assert.doesNotThrow(() => survivalState.settle(), "settle must not throw scanning done for abandoned steps after a budget drop");
const survived = survivalState.snapshot().responses.at(-1)!;
assert.equal(Buffer.byteLength(survived.markdown, "utf8") <= MAX_RESPONSE_BYTES, true, "the response stays within budget");
assert.match(survived.markdown, /^x+$/, "the newest oversized message remains visible and coherent");

assert.deepEqual(responseHistory([{ type: "message", id: "assistant-before-user", message: textMessage("orphan") }, { type: "message", id: "no-id", message: { role: "user", content: [] } }, { type: "message", message: textMessage("visible") }], NONCE).map(response => [response.id, response.markdown]), [["restored-1", "orphan"], ["no-id", "visible"]]);
assert.deepEqual(responseHistory([{ type: "message", message: { role: "user", content: [] } }, { type: "message", message: textMessage("") }], NONCE), []);
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
const snapshot = (revision: number): ViewerSnapshot => ({ status: "running", responses: [{ id: `state-${revision}`, markdown: `state-${revision}`, prompt: null, status: "running", error: null, truncated: false }], latestId: `state-${revision}`, revision, nonce: "test-nonce" });
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
historyState.restore(Array.from({ length: MAX_RESPONSES + 4 }, (_, index) => ({ id: `restored-${index}`, markdown: `response-${index}`, prompt: null, status: "complete" as const, error: null, truncated: false })));
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
const capState = new ViewerState(); capState.restore([{ id: "big", markdown: oversized, prompt: null, status: "complete", error: null, truncated: false }]);
const capped = capState.snapshot().responses[0];
assert.equal(Buffer.byteLength(capped.markdown, "utf8") <= MAX_RESPONSE_BYTES, true); assert.equal(Buffer.byteLength(capped.markdown, "utf8") + Buffer.byteLength("가", "utf8") > MAX_RESPONSE_BYTES, true);
assert.equal(capped.truncated, true); assert.equal(capped.markdown.includes("�"), false, "UTF-8 truncation does not split a code point");
capState.beginTurn(); capState.stream("retained latest"); capState.settle();
assert.deepEqual(capState.snapshot().responses.map(response => response.markdown), ["retained latest"], "byte bounds drop old responses before the newest");
const failedState = new ViewerState(); failedState.beginTurn(); failedState.stream("partial"); failedState.fail(); failedState.settle("generic failure");
assert.deepEqual(failedState.snapshot().responses.at(-1), { id: "live-1", markdown: "partial", prompt: null, status: "error", error: "generic failure", truncated: false });
const retryState = new ViewerState(); retryState.beginTurn(); retryState.stream("intermediate"); retryState.fail(); retryState.stream("retry-final"); retryState.settle("generic failure");
assert.deepEqual(retryState.snapshot().responses.map(response => [response.markdown, response.status, response.error]), [["retry-final", "complete", null]], "a retry after failure retains one successful response");
const segmentState = new ViewerState(); segmentState.beginTurn();
segmentState.beginMessage(); segmentState.stream("first"); segmentState.stream("first message");
segmentState.beginMessage(); segmentState.beginMessage(); segmentState.stream("second message"); segmentState.settle();
assert.deepEqual(segmentState.snapshot().responses.map(response => [response.markdown, response.status]), [[`first message${SEGMENT_SEPARATOR}second message`, "complete"]], "stream deltas replace one message while a new message appends to the turn");
const segmentRetryState = new ViewerState(); segmentRetryState.beginTurn();
segmentRetryState.stream("kept"); segmentRetryState.beginMessage(); segmentRetryState.stream("partial"); segmentRetryState.fail();
segmentRetryState.beginMessage(); segmentRetryState.stream("after retry"); segmentRetryState.settle("generic failure");
assert.deepEqual(segmentRetryState.snapshot().responses.map(response => [response.markdown, response.status]), [[`kept${SEGMENT_SEPARATOR}after retry`, "complete"]], "a retry drops the failed message's partial text and keeps finished ones");
assert.equal(closeOpenFence("```yaml\nkey: value"), "```yaml\nkey: value\n```", "a message cut off inside a fence is closed");
assert.equal(closeOpenFence("```yaml\nkey: value\n```\ntail"), "```yaml\nkey: value\n```\ntail", "a balanced fence is left alone");
assert.equal(closeOpenFence("prose with ``` inline backticks"), "prose with ``` inline backticks", "only a fence at the start of a line counts");
assert.equal(closeOpenFence("```\n```js\ncode\n```"), "```\n```js\ncode\n```", "a fence carrying an info string cannot close a block");
assert.equal(closeOpenFence("```\ntext\n```js\nmore"), "```\ntext\n```js\nmore\n```", "an info string inside an open block leaves it open");
assert.equal(closeOpenFence("~~~\ncode\n```"), "~~~\ncode\n```\n~~~", "a closer has to match the opening delimiter");
const settledFence = new ViewerState(); settledFence.beginTurn();
settledFence.stream("intro"); settledFence.beginMessage(); settledFence.stream("```js\nconst x = 1"); settledFence.settle();
assert.equal(settledFence.snapshot().responses.at(-1)?.markdown, `intro${SEGMENT_SEPARATOR}` + "```js\nconst x = 1\n```", "a settled turn closes the fence its last message left open");
const failedFenceTurn = new ViewerState(); failedFenceTurn.beginTurn();
failedFenceTurn.stream("partial"); failedFenceTurn.fail(); failedFenceTurn.settle("generic failure");
assert.equal(failedFenceTurn.snapshot().responses.at(-1)?.markdown, "partial", "a failed turn keeps the text the reader already saw");
const retryBackoff = new ViewerState(); retryBackoff.beginTurn(); retryBackoff.stream("Here is the ans"); retryBackoff.fail();
assert.equal(retryBackoff.splitTurn("generic failure"), false, "a prompt typed during retry backoff does not split the turn");
retryBackoff.stream("Here is the answer: 42"); retryBackoff.settle("generic failure");
assert.deepEqual(retryBackoff.snapshot().responses.map(response => [response.markdown, response.status]), [["Here is the answer: 42", "complete"]], "the retry stays one clean response");
const fenceState = new ViewerState(); fenceState.beginTurn();
fenceState.stream("```yaml\nkey: value"); fenceState.beginMessage(); fenceState.stream("after the tool call"); fenceState.settle();
assert.equal(fenceState.snapshot().responses.at(-1)?.markdown, "```yaml\nkey: value\n```" + SEGMENT_SEPARATOR + "after the tool call", "an unterminated fence cannot swallow the rest of the turn");
const bigSegment = (mark: string) => mark + "x".repeat(Math.floor(MAX_RESPONSE_BYTES * 0.45));
const longTurn = new ViewerState(); longTurn.beginTurn();
longTurn.stream(bigSegment("A")); longTurn.beginMessage();
longTurn.stream(bigSegment("B")); longTurn.beginMessage();
longTurn.stream(bigSegment("C")); longTurn.settle();
const longResponse = longTurn.snapshot().responses.at(-1)!;
assert.equal(longResponse.markdown.startsWith("B"), true, "an oversized turn drops whole oldest messages");
assert.equal(longResponse.markdown.includes(`${SEGMENT_SEPARATOR}C`), true, "the newest message of an oversized turn stays visible");
assert.equal(longResponse.truncated, true, "dropping a message marks the response truncated");
assert.equal(Buffer.byteLength(longResponse.markdown, "utf8") <= MAX_RESPONSE_BYTES, true);
const restoredLong = responseHistory([{ type: "message", id: "long-turn", message: { role: "user", content: [] } }, ...["A", "B", "C"].map(mark => ({ type: "message", message: textMessage(bigSegment(mark)) }))], NONCE);
assert.equal(restoredLong.length, 1);
assert.equal(restoredLong[0].markdown.startsWith("B"), true, "restore drops the oldest messages of an oversized turn too");
assert.equal(restoredLong[0].markdown.includes(`${SEGMENT_SEPARATOR}C`), true);
assert.equal(restoredLong[0].truncated, true);
assert.equal(Buffer.byteLength(restoredLong[0].markdown, "utf8") <= MAX_RESPONSE_BYTES, true);
const splitState = new ViewerState(); splitState.beginTurn();
assert.equal(splitState.splitTurn("generic failure"), false, "a prompt for a turn with no text yet is not a split");
splitState.stream("answered");
assert.equal(splitState.splitTurn("generic failure"), true);
splitState.stream("answered again"); splitState.settle();
assert.deepEqual(splitState.snapshot().responses.map(response => [response.markdown, response.status]), [["answered", "complete"], ["answered again", "complete"]], "an injected prompt ends one response and opens the next");

const state = new ViewerState(); state.restore([{ id: "previous", markdown: "previous", prompt: null, status: "complete", error: null, truncated: false }]); state.beginTurn(); state.stream("# current");
const viewer = await startViewerServer(here, () => state.snapshot());
const url = new URL(viewer.url);
type Result = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
const get = (path: string, method = "GET", host = url.host) => new Promise<Result>((resolve, reject) => {
	const req = request({ host: "127.0.0.1", port: url.port, path, method, headers: { Host: host } }, res => { let body = ""; res.setEncoding("utf8"); res.on("data", chunk => body += chunk); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body })); });
	req.on("error", reject); req.end();
});
const page = await get(url.pathname);
assert.equal(page.status, 200); assert.match(String(page.headers["content-security-policy"]), /default-src 'self'/); assert.match(String(page.headers["content-security-policy"]), /font-src 'none'/); assert.equal(page.headers["cache-control"], "no-store, max-age=0"); assert.equal(page.headers["x-content-type-options"], "nosniff"); assert.equal(page.headers["access-control-allow-origin"], undefined);
assert.equal((await get(url.pathname, "GET", "localhost:1")).status, 404);
assert.equal((await get(`${url.pathname}renderer.js`)).status, 200, "renderer is served beneath the tokenized path");
for (const name of ["prism-core", "prism-markup", "prism-clike", "prism-javascript", "prism-typescript", "prism-go", "prism-python", "prism-bash", "prism-yaml", "prism-json", "prism-sql", "prism-hcl", "prism-docker", "prism-markdown"]) {
	const asset = await get(`${url.pathname}vendor/${name}-1.30.0.min.js`);
	assert.equal(asset.status, 200, `${name} is tokenized and served`);
	assert.equal(asset.headers["content-type"], "text/javascript; charset=utf-8");
	assert.equal((await get(`${url.pathname}vendor/${name}-1.30.0.min.js`, "POST")).status, 405);
}
const syntax = await get(`${url.pathname}syntax.js`); assert.equal(syntax.status, 200); assert.equal(syntax.headers["content-type"], "text/javascript; charset=utf-8"); assert.equal((await get(`${url.pathname}syntax.js`, "POST")).status, 405);
for (const name of ["fence-renderers", "diff-view", "json-view", "csv-view", "navigator", "export-view"]) { const asset = await get(`${url.pathname}${name}.js`); assert.equal(asset.status, 200, `${name} is tokenized and served`); assert.equal(asset.headers["content-type"], "text/javascript; charset=utf-8"); assert.equal((await get(`${url.pathname}${name}.js`, "POST")).status, 405); }
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
let branch: unknown[] = [{ type: "message", message: textMessage("restored") }];
const tuiContext = { mode: "tui", sessionManager: { getBranch: () => branch }, ui: { notify: () => undefined } };
const savedChild = process.env.PI_SUBAGENT_CHILD;
const restoreChild = () => { if (savedChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = savedChild; };
process.once("exit", restoreChild);
delete process.env.PI_SUBAGENT_CHILD;
await fire("session_start", {}, tuiContext);
const latestResponse = (next: ViewerSnapshot) => next.responses.find(response => response.id === next.latestId);
assert.equal(fakeServers.length, 1); assert.equal(latestResponse(fakeServers[0].publishes.at(-1)!.snapshot)?.markdown, "restored");
await fire("before_agent_start", {}, tuiContext);
await fire("agent_start", {}, tuiContext); await fire("agent_start", {}, tuiContext);
assert.deepEqual(lifecycleLaunches, [fakeServers[0].url], "low-level retries open the browser only once and do not append a response");
await fire("message_start", { message: textMessage("") }, tuiContext);
await fire("message_update", { message: textMessage("tool-intermediate") }, tuiContext);
await fire("message_end", { message: { role: "tool", content: [{ type: "text", text: "tool data must not leak" }] } }, tuiContext);
await fire("message_start", { message: { role: "toolResult", content: [{ type: "text", text: "tool data must not leak" }] } }, tuiContext);
await fire("message_start", { message: textMessage("") }, tuiContext);
await fire("message_end", { message: textMessage("assistant-final") }, tuiContext);
assert.equal(latestResponse(fakeServers[0].publishes.at(-1)!.snapshot)?.markdown, `tool-intermediate${SEGMENT_SEPARATOR}assistant-final`, "text written before a tool call stays visible alongside the final text");
assert.equal(latestResponse(fakeServers[0].publishes.at(-1)!.snapshot)?.status, "running", "assistant message_end does not finalize the high-level turn");
await fire("agent_settled", {}, tuiContext);
assert.equal(fakeServers[0].publishes.at(-1)!.snapshot.status, "complete");
await fire("before_agent_start", {}, tuiContext);
await fire("agent_start", {}, tuiContext);
await fire("message_start", { message: textMessage("") }, tuiContext);
await fire("message_update", { message: textMessage("safe partial") }, tuiContext);
await fire("message_end", { message: textMessage("provider details must not reach browser", "error", "provider secret") }, tuiContext);
await fire("agent_start", {}, tuiContext);
await fire("message_start", { message: textMessage("") }, tuiContext);
await fire("message_update", { message: textMessage("retry final") }, tuiContext);
await fire("agent_settled", {}, tuiContext);
assert.deepEqual(fakeServers[0].publishes.at(-1)!.snapshot.responses.slice(-2).map(response => [response.markdown, response.status]), [[`tool-intermediate${SEGMENT_SEPARATOR}assistant-final`, "complete"], ["retry final", "complete"]], "retry remains one response in its original high-level turn");
assert.doesNotMatch(JSON.stringify(fakeServers[0].publishes.at(-1)!.snapshot), /provider details|provider secret|tool data must not leak/);
await fire("before_agent_start", {}, tuiContext);
await fire("agent_settled", {}, tuiContext);
assert.equal(fakeServers[0].publishes.at(-1)!.snapshot.responses.length, 3, "a second high-level boundary creates a distinct turn while an empty one remains invisible");
// Steering and follow-up prompts arrive inside the running agent loop, so only their message_start
// separates the responses. Live grouping has to match what responseHistory rebuilds on restore.
const beforeSteering = fakeServers[0].publishes.at(-1)!.snapshot.responses.length;
await fire("before_agent_start", {}, tuiContext);
await fire("agent_start", {}, tuiContext);
await fire("message_start", { message: { role: "user", content: [{ type: "text", text: "ordinary prompt stays out of the body" }] } }, tuiContext);
assert.equal(fakeServers[0].publishes.at(-1)!.snapshot.responses.length, beforeSteering, "the prompt that opens a turn is not a split");
await fire("message_start", { message: textMessage("") }, tuiContext);
await fire("message_update", { message: textMessage("first answer") }, tuiContext);
assert.doesNotMatch(fakeServers[0].publishes.at(-1)!.snapshot.responses.map(response => response.markdown).join("\n"), /ordinary prompt stays out of the body/, "a prompt never enters the rendered body");
assert.equal(fakeServers[0].publishes.at(-1)!.snapshot.responses.at(-1)?.prompt?.text, "ordinary prompt stays out of the body", "a prompt is carried in its own field");
await fire("message_start", { message: { role: "user", content: [{ type: "text", text: "steering prompt stays out of the body" }] } }, tuiContext);
await fire("message_start", { message: textMessage("") }, tuiContext);
await fire("message_update", { message: textMessage("steered answer") }, tuiContext);
await fire("agent_settled", {}, tuiContext);
const steered = fakeServers[0].publishes.at(-1)!.snapshot;
assert.deepEqual(steered.responses.slice(-2).map(response => [response.markdown, response.status]), [["first answer", "complete"], ["steered answer", "complete"]], "a mid-run steering prompt starts a new response instead of extending the previous one");
assert.doesNotMatch(steered.responses.map(response => response.markdown).join("\n"), /steering prompt stays out of the body/, "a prompt never enters the rendered body");
// splitTurn (which settles the previous response) runs before setPrompt in the message_start handler,
// so the steering prompt must attach to the response it newly opens, not the one the split just settled.
assert.equal(steered.responses.at(-1)?.prompt?.text, "steering prompt stays out of the body", "the steering prompt attaches to the response it opens");
assert.equal(steered.responses.at(-2)?.prompt?.text, "ordinary prompt stays out of the body", "the response settled by the split keeps the prompt it already had, not the steering prompt");
branch = [{ type: "message", id: "tree-user", message: { role: "user", content: [{ type: "text", text: "tree prompt stays out of the body" }] } }, { type: "message", message: textMessage("tree-restored") }];
await fire("session_tree", {}, tuiContext);
const treeSnapshot = fakeServers[0].publishes.at(-1)!.snapshot;
assert.equal(latestResponse(treeSnapshot)?.markdown, "tree-restored");
assert.doesNotMatch(treeSnapshot.responses.map(response => response.markdown).join("\n"), /tree prompt stays out of the body/, "a restored prompt never enters the rendered body");
assert.equal(latestResponse(treeSnapshot)?.prompt?.text, "tree prompt stays out of the body", "session_tree restore carries the prompt in its own field");
assert.equal(fakeServers[0].publishes.at(-1)!.immediate, true);
await viewerCommand!.handler("", tuiContext); assert.deepEqual(lifecycleLaunches, [fakeServers[0].url, fakeServers[0].url]);
await fire("session_start", {}, tuiContext);
assert.equal(fakeServers[0].closes, 1, "replacement start closes the old viewer"); assert.equal(fakeServers.length, 2);
await fire("agent_start", {}, tuiContext); assert.equal(lifecycleLaunches.length, 3, "replacement can open its new URL once");
await fire("session_shutdown", {}, tuiContext); assert.equal(fakeServers[1].closes, 1);

// --- turn context: extension wiring ---
// contentSegments gates on role the same way assistantText does: a message of any other role —
// including one the viewer does not recognize — contributes no segment.
assert.deepEqual(contentSegments({ role: "tool", content: [{ type: "text", text: "must not leak" }] }, "n"), [], "an unrecognized role contributes no segment");
assert.deepEqual(contentSegments({ role: "user", content: [{ type: "text", text: "my prompt" }] }, "n"), [], "a user message is not body content");
{
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const publishes: ViewerSnapshot[] = [];
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, handler); },
		registerCommand() {},
	};
	createResponseViewer(pi as unknown as ExtensionAPI, {
		directory: here,
		launchViewer: () => {},
		startServer: async (_directory, getState) => ({
			url: "http://127.0.0.1/fake",
			publish() { publishes.push(getState()); },
			async close() {},
		}),
	});
	const ctx = { mode: "tui", ui: {} };
	await handlers.get("session_start")!({}, ctx);
	handlers.get("before_agent_start")!({}, ctx);
	handlers.get("message_start")!({ message: { role: "user", content: [{ type: "text", text: "why is it slow?" }] } }, ctx);
	handlers.get("message_start")!({ message: { role: "assistant" } }, ctx);
	handlers.get("message_update")!({ message: { role: "assistant", content: [{ type: "text", text: "checking" }] } }, ctx);
	handlers.get("message_end")!({ message: { role: "assistant", content: [
		{ type: "text", text: "checking" },
		{ type: "toolCall", id: "c1", name: "Bash", arguments: { command: "npm test" } },
	] } }, ctx);
	handlers.get("message_end")!({ message: { role: "toolResult", toolCallId: "c1", toolName: "Bash", content: [{ type: "text", text: "3 passed" }], isError: false } }, ctx);
	// Whichever source Pi actually uses, the first delivery wins and the second changes nothing.
	handlers.get("tool_result")!({ toolCallId: "c1", toolName: "Bash", content: [{ type: "text", text: "IGNORED SECOND DELIVERY" }], isError: true }, ctx);
	handlers.get("agent_settled")!({}, ctx);

	const final = publishes.at(-1)!;
	const response = final.responses.at(-1)!;
	assert.equal(response.prompt?.text, "why is it slow?", "the prompt becomes the response header");
	const steps = response.markdown.split(SEGMENT_SEPARATOR).map(segment => parseToolStep(segment, final.nonce)).filter(Boolean);
	assert.equal(steps.length, 1);
	assert.equal(steps[0]!.name, "Bash");
	assert.equal(steps[0]!.summary, "npm test");
	assert.equal(steps[0]!.status, "ok");
	assert.equal(steps[0]!.result, "3 passed", "the first delivery wins; the second is ignored");
	assert.equal(response.status, "complete");
}

// The `tool_result` event alone must also complete a step, for a Pi build that emits only that.
{
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const publishes: ViewerSnapshot[] = [];
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, handler); },
		registerCommand() {},
	};
	createResponseViewer(pi as unknown as ExtensionAPI, {
		directory: here,
		launchViewer: () => {},
		startServer: async (_directory, getState) => ({ url: "http://127.0.0.1/fake", publish() { publishes.push(getState()); }, async close() {} }),
	});
	const ctx = { mode: "tui", ui: {} };
	await handlers.get("session_start")!({}, ctx);
	handlers.get("before_agent_start")!({}, ctx);
	handlers.get("message_start")!({ message: { role: "assistant" } }, ctx);
	handlers.get("message_end")!({ message: { role: "assistant", content: [
		{ type: "text", text: "running it" },
		{ type: "toolCall", id: "c9", name: "Bash", arguments: { command: "ls" } },
	] } }, ctx);
	handlers.get("tool_result")!({ toolCallId: "c9", toolName: "Bash", content: [{ type: "text", text: "boom" }], isError: true }, ctx);
	handlers.get("agent_settled")!({}, ctx);
	const final = publishes.at(-1)!;
	const step = final.responses.at(-1)!.markdown.split(SEGMENT_SEPARATOR).map(segment => parseToolStep(segment, final.nonce)).find(Boolean);
	assert.equal(step?.status, "error", "tool_result alone completes the step");
	assert.equal(step?.result, "boom");
}

// UserMessage.content may be a bare string rather than an array of text blocks; the prompt must
// still reach `response.prompt.text` in that shape.
{
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const publishes: ViewerSnapshot[] = [];
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, handler); },
		registerCommand() {},
	};
	createResponseViewer(pi as unknown as ExtensionAPI, {
		directory: here,
		launchViewer: () => {},
		startServer: async (_directory, getState) => ({ url: "http://127.0.0.1/fake", publish() { publishes.push(getState()); }, async close() {} }),
	});
	const ctx = { mode: "tui", ui: {} };
	await handlers.get("session_start")!({}, ctx);
	handlers.get("before_agent_start")!({}, ctx);
	handlers.get("message_start")!({ message: { role: "user", content: "string-form prompt" } }, ctx);
	handlers.get("message_start")!({ message: { role: "assistant" } }, ctx);
	handlers.get("message_update")!({ message: { role: "assistant", content: [{ type: "text", text: "on it" }] } }, ctx);
	handlers.get("agent_settled")!({}, ctx);
	const final = publishes.at(-1)!;
	assert.equal(final.responses.at(-1)!.prompt?.text, "string-form prompt", "a bare-string UserMessage.content still becomes the prompt");
}

const disabledHandlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
const disabledPi = { on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { disabledHandlers.set(event, handler); }, registerCommand() {} };
let disabledStarts = 0, disabledLaunches = 0;
createResponseViewer(disabledPi as unknown as ExtensionAPI, { ...dependencies, startServer: async () => { disabledStarts += 1; throw new Error("must not start"); }, launchViewer: () => { disabledLaunches += 1; } });
await disabledHandlers.get("session_start")!({}, { ...tuiContext, mode: "rpc" }); await disabledHandlers.get("agent_start")!({}, { ...tuiContext, mode: "rpc" });
process.env.PI_SUBAGENT_CHILD = "1";
assert.equal(viewerEnabled(tuiContext), false);
await disabledHandlers.get("session_start")!({}, tuiContext); await disabledHandlers.get("agent_start")!({}, tuiContext);
assert.equal(disabledStarts, 0); assert.equal(disabledLaunches, 0, "non-TUI and child runs have no server or browser");
delete process.env.PI_SUBAGENT_CHILD;

// /viewer on|off toggles the viewer for the current session; other event handlers are unaffected.
const toggleHandlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
let toggleCommand: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
const togglePi = {
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { toggleHandlers.set(event, handler); },
	registerCommand(_name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) { toggleCommand = command; },
};
const toggleServers: Array<ViewerServer & { publishes: Array<{ snapshot: ViewerSnapshot; immediate: boolean }>; closes: number }> = [];
const toggleLaunches: string[] = [];
const toggleNotifications: Array<{ text: string; level?: string }> = [];
const toggleDependencies: Partial<ViewerDependencies> = {
	directory: here,
	launchViewer: url => toggleLaunches.push(url),
	startServer: async (_directory, getState) => {
		const fake = {
			url: `http://127.0.0.1/toggle-${toggleServers.length}`,
			publishes: [] as Array<{ snapshot: ViewerSnapshot; immediate: boolean }>,
			closes: 0,
			publish(next: ViewerSnapshot, immediate = false) { this.publishes.push({ snapshot: next, immediate }); },
			async close() { this.closes += 1; },
		};
		void getState();
		toggleServers.push(fake);
		return fake;
	},
};
createResponseViewer(togglePi as unknown as ExtensionAPI, toggleDependencies);
const toggleBranch: unknown[] = [{ type: "message", message: textMessage("toggle-restored") }];
const toggleContext = { mode: "tui", sessionManager: { getBranch: () => toggleBranch }, ui: { notify: (text: string, level?: string) => toggleNotifications.push({ text, level }) } };
const toggleFire = async (event: string, payload: unknown, context: unknown) => { const handler = toggleHandlers.get(event); assert.ok(handler, `missing ${event}`); await handler(payload, context); };
await toggleFire("session_start", {}, toggleContext);
assert.equal(toggleServers.length, 1, "session_start opens the first viewer server");

// /viewer off closes the server and stops publishing for the rest of the session.
await toggleCommand!.handler("off", toggleContext);
assert.equal(toggleServers[0].closes, 1, "/viewer off closes the running server");
assert.equal(toggleNotifications.at(-1)?.text, "Response viewer disabled for this session.");
const publishesBeforeDisabledUpdate = toggleServers[0].publishes.length;
await toggleFire("message_update", { message: textMessage("must not publish while disabled") }, toggleContext);
assert.equal(toggleServers[0].publishes.length, publishesBeforeDisabledUpdate, "a disabled viewer does not publish on message_update");

// /viewer on after off restarts the server, restores history, and opens the new URL.
await toggleCommand!.handler("on", toggleContext);
assert.equal(toggleServers.length, 2, "/viewer on starts a fresh server");
assert.equal(latestResponse(toggleServers[1].publishes.at(-1)!.snapshot)?.markdown, "toggle-restored", "/viewer on restores history");
assert.deepEqual(toggleLaunches, [toggleServers[1].url], "/viewer on opens the browser at the new URL");

// bare /viewer while off behaves exactly like /viewer on.
await toggleCommand!.handler("off", toggleContext);
assert.equal(toggleServers[1].closes, 1);
await toggleCommand!.handler("", toggleContext);
assert.equal(toggleServers.length, 3, "bare /viewer while off starts a new server just like /viewer on");
assert.deepEqual(toggleLaunches, [toggleServers[1].url, toggleServers[2].url]);

// An unknown argument only reports usage; the running server is untouched.
await toggleCommand!.handler("bogus", toggleContext);
assert.equal(toggleServers.length, 3, "unknown argument does not start another server");
assert.equal(toggleServers[2].closes, 0, "unknown argument leaves the running server open");
assert.equal(toggleNotifications.at(-1)?.text, "Usage: /viewer [on|off]");
assert.deepEqual(toggleLaunches, [toggleServers[1].url, toggleServers[2].url], "unknown argument does not open the browser");
await toggleFire("session_shutdown", {}, toggleContext);

const template = await readFile(join(here, "template.html"), "utf8");
const client = await readFile(join(here, "client.js"), "utf8");
const syntaxSource = await readFile(join(here, "syntax.js"), "utf8");
const mermaidViewSource = await readFile(join(here, "mermaid-view.js"), "utf8");
const treeViewSource = await readFile(join(here, "tree-view.js"), "utf8");
const rendererSource = await readFile(join(here, "renderer.js"), "utf8");
const fenceSource = await readFile(join(here, "fence-renderers.js"), "utf8");
const diffSource = await readFile(join(here, "diff-view.js"), "utf8");
const jsonSource = await readFile(join(here, "json-view.js"), "utf8");
const csvSource = await readFile(join(here, "csv-view.js"), "utf8");
const navigatorSource = await readFile(join(here, "navigator.js"), "utf8");
const exportSource = await readFile(join(here, "export-view.js"), "utf8");
const prismLicense = await readFile(join(here, "vendor", "LICENSE-prism.txt"), "utf8");
const markedLicense = await readFile(join(here, "vendor", "LICENSE-marked.txt"), "utf8");
const dompurifyLicense = await readFile(join(here, "vendor", "LICENSE-dompurify.txt"), "utf8");
const mermaidLicense = await readFile(join(here, "vendor", "LICENSE-mermaid.txt"), "utf8");
assert.doesNotMatch(template, /composer|static-raw|@font-face|\.woff2/i);
assert.doesNotMatch(template, /https?:\/\//i);
assert.match(template, /Pretendard,"Apple SD Gothic Neo"/);
assert.match(template, /--mono:ui-monospace/);
assert.match(template, /vendor\/marked-18\.0\.5\.umd\.js/);
assert.match(template, /vendor\/mermaid-11\.16\.1\.min\.js/);
assert.match(template, /<script src="mermaid-view\.js">/);
assert.match(template, /<script src="tree-view\.js">/); for (const name of ["fence-renderers", "diff-view", "json-view", "csv-view", "navigator", "export-view"]) assert.match(template, new RegExp(`<script src="${name}\\.js">`));
assert.match(template, /@media print/);
assert.match(template, /\.toolbar,.outline,.new-content,.heading-link,.sr-only,.code-actions \{ display:none !important;/);
assert.match(template, /pre,pre\.code-collapsed,pre\.code-wrapped \{ max-height:none !important;/);
assert.match(template, /\.diff-view \{ max-height:none !important; overflow:visible !important; \}/);
assert.match(client, /events\.close\(\)/);
assert.match(client, /copy\(plain, copyButton\)/);
assert.match(client, /codePreferences/);
assert.match(client, /selectedId/);
assert.match(client, /ResponseViewerFences\.render\(language\[0\]/);
assert.match(client, /ResponseViewerNavigator\.create/);
assert.match(client, /ResponseViewerExport\.create/);
assert.match(client, /ResponseViewerMermaid\.onThemeChange\(\)/);
assert.match(syntaxSource, /Prism\.manual/);
assert.match(syntaxSource, /ALLOWED_TAGS: \["span"\]/);
assert.match(syntaxSource, /\["mermaid", \["mermaid", "Mermaid"\]\]/);
assert.match(syntaxSource, /\["tree", \["tree", "Tree"\]\]/); assert.match(syntaxSource, /\["diff", \["diff", "Diff"\]\]/); assert.match(syntaxSource, /\["csv", \["csv", "CSV"\]\]/);
assert.match(prismLicense, /MIT LICENSE/i); assert.match(markedLicense, /MIT license/i); assert.match(dompurifyLicense, /Apache License/i); assert.match(mermaidLicense, /MIT License/i);
assert.doesNotMatch(`${template}\n${syntaxSource}`, /https?:\/\//, "production template and syntax helper contain no remote URL");
assert.match(rendererSource, /(?:title|filename)/); assert.match(rendererSource, /slice\(0, 512\)/); assert.match(fenceSource, /MAX_SOURCE/); assert.match(diffSource, /MAX_LINES/); assert.match(jsonSource, /MAX_NODES/); assert.match(csvSource, /MAX_CELLS/); assert.match(navigatorSource, /ResponseViewerNavigator/); assert.match(navigatorSource, /if \(needle\) \{[\s\S]*item\.folded === undefined/); assert.match(navigatorSource, /else \{[\s\S]*item\.folded = undefined/); assert.match(navigatorSource, /originalRange/); assert.doesNotMatch(navigatorSource, /ranges/); assert.match(exportSource, /createObjectURL/);
assert.doesNotMatch(mermaidViewSource, /https?:\/\//, "mermaid wrapper contains no remote URL");
// The SVG namespace URI is a required literal, not a fetched remote reference.
assert.match(treeViewSource, /http:\/\/www\.w3\.org\/2000\/svg/, "tree icons use the standard SVG namespace");
const toolStepSource = await readFile(join(here, "tool-step-view.js"), "utf8");
const thinkingSource = await readFile(join(here, "thinking-view.js"), "utf8");
assert.doesNotMatch(`${toolStepSource}\n${thinkingSource}`, /innerHTML/, "the new renderers never use innerHTML");
assert.match(template, /tool-step-view\.js/);
assert.match(template, /thinking-view\.js/);
const serverSource = await readFile(join(here, "server.ts"), "utf8");
assert.match(serverSource, /tool-step-view\.js/);
assert.match(serverSource, /thinking-view\.js/);
const securityTestSource = await readFile(join(here, "security-test.ts"), "utf8");
assert.match(securityTestSource, /tool-step-view\.js/);
assert.match(securityTestSource, /thinking-view\.js/);
assert.match(syntaxSource, /\["pi-tool", \["pi-tool", "Tool"\]\]/);
assert.match(syntaxSource, /\["pi-think", \["pi-think", "Thinking"\]\]/);
restoreChild(); process.removeListener("exit", restoreChild);
console.log("PASS: response-viewer state, async spawn failure, bounded SSE, HTTP policy, links, lifecycle, viewer on/off, shutdown, and template shell");
