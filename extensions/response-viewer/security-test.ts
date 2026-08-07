import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const here = dirname(fileURLToPath(import.meta.url));
const chrome = [process.env.RESPONSE_VIEWER_CHROME, process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path): path is string => Boolean(path && existsSync(path)));

if (!chrome) {
	console.log("SKIP: response-viewer browser smoke (Chrome/Chromium missing)");
} else {
	const directory = await mkdtemp(join(tmpdir(), "pi-response-viewer-"));
	try {
		const file = join(directory, "smoke.html");
		const asset = (path: string) => pathToFileURL(join(here, path)).href;
		const template = await readFile(join(here, "template.html"), "utf8");
		const prelude = `<script>
class EventSourceMock { constructor() { this.listeners = {}; window.__events = this; } addEventListener(type, listener) { this.listeners[type] = listener; } close() {} emit(snapshot) { this.listeners.state({ data: JSON.stringify(snapshot) }); } }
window.EventSource = EventSourceMock;
window.__media = []; window.matchMedia = query => { const listeners = new Set(), item = { media: query, matches: false, onchange: null, addEventListener(type, listener) { if (type === "change") listeners.add(listener); }, removeEventListener(type, listener) { if (type === "change") listeners.delete(listener); }, addListener(listener) { listeners.add(listener); }, removeListener(listener) { listeners.delete(listener); }, dispatchEvent(event) { listeners.forEach(listener => listener(event)); return true; }, __listeners: listeners }; window.__media.push(item); return item; }; window.__setNarrow = matches => window.__media.filter(item => item.media.includes("max-width: 1180px")).forEach(item => { item.matches = matches; const event = { matches, media: item.media }; item.onchange?.(event); item.__listeners.forEach(listener => listener(event)); });
window.__copied = []; window.__downloads = []; window.__printCalls = 0;
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => window.__copied.push(text) } });
URL.createObjectURL = blob => { window.__downloads.push({ blob }); return "blob:viewer-test"; }; URL.revokeObjectURL = () => {};
HTMLAnchorElement.prototype.click = function() { window.__downloads[window.__downloads.length - 1].name = this.download; };
window.print = () => { window.__printCalls++; };
</script>`;
		const smoke = `<script>
(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const ok = (value, message) => { if (!value) throw new Error(message); };
  const pollUntil = async (predicate, timeout = 4000, interval = 50) => { const start = performance.now(); while (performance.now() - start < timeout) { if (predicate()) return true; await wait(interval); } return predicate(); };
  try {
    const response = (id, markdown, status = "complete", prompt = null) => ({ id, markdown, status, error: null, truncated: false, prompt });
    const longCode = Array.from({ length: 25 }, (_, index) => "line " + index).join("\\n");
    const validMermaid = "graph TD; A-->B;";
    const hostileMermaid = ["graph TD", "A[\\\"<img src=x onerror=window.__pwned=1>\\\"]-->B", "click A \\\"javascript:window.__pwned=1\\\"", "click B \\\"https://evil.example\\\""].join("\\n");
    const brokenMermaid = "graph TD; A-->";
    const validTree = ["project/", "├── src/", "│   ├── index.js", "│   └── <script>window.__pwned2=1<\\/script>", "└── README.md"].join("\\n");
    const malformedTree = ["root/", "│   ├── deep.js"].join("\\n");
    const validDiff = ["diff --git a/a.js b/a.js", "--- a/a.js", "+++ b/a.js", "@@ -1 +1 @@", "-old", "+new <img onerror=window.__pwned3=1>"].join("\\n");
    const validMultiDiff = [validDiff, "diff --git a/b.js b/b.js", "--- a/b.js", "+++ b/b.js", "@@ -1 +1 @@", "-before", "+after"].join("\\n");
    const validUnifiedDiff = ["--- old.conf", "+++ new.conf", "@@ -1 +1 @@", "--- option", "+++ option"].join("\\n");
    const invalidSecondDiff = [validDiff, "diff --git a/b.js b/b.js", "@@ -1 +1 @@", "-before", "+after"].join("\\n");
    const validCsv = ["name,value", "first,2", "alpha,1", "beta,1", "gamma,3", "=literal,4"].join("\\n");
    const older = "# Older\\n\\nOlder body only";
    const latest = ["# Latest", "The body-only-needle appears in this paragraph.", "<img src=x onerror=alert(1)>", "~~~javascript title=\\\"src/<img onerror=window.__titlePwned=1>.ts\\\"", "const answer = 42;", "~~~", "~~~javascript filename=\\\"weird <img onerror=window.__filenamePwned=1>.ts\\\"", "const filename = true;", "~~~", "~~~unknown", "<img src=x onerror=alert(1)>", "~~~", "~~~text", longCode, "~~~", "~~~mermaid", validMermaid, "~~~", "~~~mermaid", hostileMermaid, "~~~", "~~~mermaid", brokenMermaid, "~~~", "~~~tree", validTree, "~~~", "~~~tree", malformedTree, "~~~", "~~~diff", validDiff, "~~~", "~~~json", "{\\\"safe\\\": [1, true], \\\"__proto__\\\": \\\"literal\\\"}", "~~~", "~~~csv", validCsv, "~~~"].join("\\n\\n");
    window.__events.emit({ status: "complete", responses: [response("older", older), response("latest", latest)], latestId: "latest", revision: 1 });
    const body = document.getElementById("response-body"), panel = document.getElementById("response-navigator");
    ok(await pollUntil(() => body.querySelectorAll(".code-block").length === (latest.match(/~~~/g) || []).length / 2), "the initial response did not finish rendering");
    ok(panel.open, "desktop navigator did not initialize open"); window.__setNarrow(true); ok(!panel.open, "narrow navigator did not collapse"); window.__setNarrow(false); ok(panel.open, "desktop navigator did not reopen");
    ok(!body.querySelector(".response-prompt"), "a response with a null prompt rendered a header");
    ok(window.ResponseViewerCsv.parse("name,value\\nalpha,2"), "CSV parser rejected valid source");
    const quoted = window.ResponseViewerCsv.parse("name,value\\n\\\"comma, name\\\",2"); ok(quoted?.[1]?.[0] === "comma, name", "quoted CSV cell was not parsed");
    ok(!window.ResponseViewerCsv.parse("name,value\\n\\\"quoted\\\"suffix,2"), "CSV accepted content after a closing quote");
    ok(!window.ResponseViewerCsv.parse("a,b\\nragged"), "ragged CSV did not fall back");
    ok(window.ResponseViewerDiff.parse(validMultiDiff), "valid multi-file diff did not render");
    ok(window.ResponseViewerDiff.parse(validUnifiedDiff), "generic unified diff or hunk content resembling headers did not render");
    ok(!window.ResponseViewerDiff.parse("diff --git a/a b/a\\n--- a/a\\n@@ -1 +1 @@\\n-old\\n+new"), "diff missing +++ header did not fall back");
    ok(!window.ResponseViewerDiff.parse(invalidSecondDiff), "diff with an invalid second file did not fall back");
    ok(!window.ResponseViewerJson.build({ source: "{\\\"incomplete\\\":" }), "incomplete JSON did not fall back");
    ok(!body.querySelector("img,[onerror]") && window.__titlePwned === undefined && window.__filenamePwned === undefined, "hostile Markdown or fence metadata became active DOM");
    const blocks = [...body.querySelectorAll(".code-block")];
    const javascript = blocks.find(block => block.querySelector(".code-language").getAttribute("title") === "JavaScript");
    const unknown = blocks.find(block => block.querySelector(".code-language").textContent === "Plain");
    const long = blocks.find(block => block.querySelector(".code-expand-toggle"));
    ok(javascript?.querySelector("span.token"), "explicit JavaScript was not highlighted");
    ok(blocks.some(block => block.querySelector(".code-language").textContent.includes("<img onerror")), "hostile title/filename was not literal text");
    ok(unknown && !unknown.querySelector("span.token") && unknown.textContent.includes("<img src=x onerror"), "unknown code was highlighted or became active");
    ok(long?.querySelector("pre").classList.contains("code-collapsed"), "long code did not collapse");
    long.querySelector(".code-wrap-toggle").click(); long.querySelector(".code-expand-toggle").click();
    ok(long.querySelector("pre").classList.contains("code-wrapped") && !long.querySelector("pre").classList.contains("code-collapsed"), "code controls did not update");
    const mermaidBlocks = blocks.filter(block => block.querySelector(".code-language").textContent === "Mermaid");
    ok(mermaidBlocks.length === 3, "expected three mermaid code blocks");
    const [validMermaidBlock, hostileMermaidBlock, brokenMermaidBlock] = mermaidBlocks;
    ok(!validMermaidBlock.querySelector(".code-wrap-toggle") && !validMermaidBlock.querySelector(".code-expand-toggle"), "mermaid block kept Wrap/Expand controls");
    ok(await pollUntil(() => validMermaidBlock.querySelector(".mermaid-host svg")), "valid mermaid diagram did not render an svg");
    ok(validMermaidBlock.querySelector("pre").hidden, "valid mermaid pre was not hidden after render");
    ok(await pollUntil(() => hostileMermaidBlock.querySelector(".mermaid-host svg")), "hostile mermaid diagram did not render an svg");
    const hostileSvg = hostileMermaidBlock.querySelector(".mermaid-host svg");
    ok(!hostileSvg.querySelector("foreignObject") && !hostileSvg.innerHTML.includes("onerror") && window.__pwned === undefined, "hostile Mermaid retained active content");
    const anchorHref = anchor => anchor.getAttribute("href") ?? anchor.getAttribute("xlink:href") ?? "";
    ok(![...hostileSvg.querySelectorAll("a")].some(anchor => anchorHref(anchor).toLowerCase().startsWith("javascript:")), "javascript: Mermaid link survived");
    const externalAnchor = [...hostileSvg.querySelectorAll("a")].find(anchor => anchorHref(anchor).includes("evil.example"));
    ok(externalAnchor?.getAttribute("rel") === "noreferrer noopener" && externalAnchor.getAttribute("target") === "_blank", "external Mermaid link protection missing");
    await wait(250); ok(!brokenMermaidBlock.querySelector(".mermaid-host svg") && !brokenMermaidBlock.querySelector("pre").hidden, "broken Mermaid did not fall back");
    document.getElementById("previous-response").click(); await wait(40); document.getElementById("next-response").click();
    ok(await pollUntil(() => document.querySelector(".mermaid-host svg")), "cached Mermaid redraw did not inject after attachment");
    ok(body.querySelector(".diff-view .diff-addition")?.textContent.includes("<img onerror") && !body.querySelector(".diff-view img") && window.__pwned3 === undefined, "unified diff was not safely rendered");
    ok(body.querySelector(".json-view details") && body.querySelector(".json-key")?.textContent.includes("safe"), "JSON tree was not rendered");
    const csvHeaders = [...body.querySelectorAll(".csv-view th")], csvSort = csvHeaders[1]?.querySelector("button"); ok(csvSort, "CSV table was not rendered");
    const sourceOrder = () => [...body.querySelectorAll(".csv-view tbody tr")].map(row => row.dataset.sourceIndex).join(",");
    csvSort.click(); ok(csvHeaders[1].getAttribute("aria-sort") === "ascending" && csvSort.getAttribute("aria-sort") === null && sourceOrder() === "1,2,0,3,4", "CSV ascending sort was not accessible, stable, and reordered");
    csvSort.click(); ok(csvHeaders[1].getAttribute("aria-sort") === "descending" && sourceOrder() === "4,3,0,1,2", "CSV descending sort was not stable and reordered");
    ok([...body.querySelectorAll(".csv-view td")].some(cell => cell.textContent === "=literal"), "formula-like CSV cell was not literal text");
    const treeBlocks = blocks.filter(block => block.querySelector(".code-language").textContent === "Tree"), renderedTreeBlock = treeBlocks.find(block => block.querySelector(".tree-view")), malformedTreeBlock = treeBlocks.find(block => block.querySelector("pre"));
    ok(renderedTreeBlock?.querySelectorAll("details").length === 2 && malformedTreeBlock?.querySelector(".code-wrap-toggle"), "tree rendering/fallback was incorrect");
    ok(!renderedTreeBlock.querySelector("script") && window.__pwned2 === undefined, "hostile tree name became active DOM");
    javascript.querySelector(".copy-code").click();
    ok(await pollUntil(() => window.__copied.some(text => text.includes("const answer = 42;") && text.endsWith("\\n"))), "code copy did not preserve Marked's terminating newline");
    const search = document.getElementById("navigator-search"); search.value = "body-only-needle"; search.dispatchEvent(new Event("input", { bubbles: true }));
    const result = document.querySelector(".navigator-item"); ok(document.querySelectorAll(".navigator-item").length === 1 && document.getElementById("navigator-count").textContent === "1 of 2 responses" && result.querySelector("mark")?.textContent === "body-only-needle" && result.querySelector(".navigator-detail").textContent.includes("body-only-needle"), "navigator body-match context/highlight/count was incorrect");
    search.value = "x"; window.__events.emit({ status: "complete", responses: [response("unicode", "İX")], latestId: "unicode", revision: 2 });
    ok(await pollUntil(() => document.querySelector(".navigator-item")?.querySelector("mark")?.textContent === "X" && document.querySelector(".navigator-item")?.querySelector(".navigator-detail")?.textContent.includes("İX")), "navigator Unicode case-insensitive offsets did not preserve visible context");
    search.value = "i"; window.__events.emit({ status: "complete", responses: [response("turkish", "İstanbul")], latestId: "turkish", revision: 3 });
    ok(await pollUntil(() => document.querySelector(".navigator-item")?.querySelector("mark")?.textContent === "İ" && document.querySelector(".navigator-item")?.querySelector(".navigator-detail")?.textContent.includes("İstanbul")), "navigator lowercase i did not match the Turkish dotted-I range");
    search.value = "istanbul"; search.dispatchEvent(new Event("input", { bubbles: true })); ok(document.querySelector(".navigator-item mark")?.textContent === "İstanbul", "navigator Turkish case fold did not preserve the full visible range");
    search.value = "ος"; window.__events.emit({ status: "complete", responses: [response("greek", "ΟΣ")], latestId: "greek", revision: 4 });
    ok(await pollUntil(() => document.querySelector(".navigator-item mark")?.textContent === "ΟΣ"), "navigator lowercase Greek final sigma did not match uppercase sigma");
    const largeMarkdown = "a".repeat(1_250_000) + " Needle";
    search.value = ""; window.__events.emit({ status: "complete", responses: [response("large", largeMarkdown)], latestId: "large", revision: 5 });
    ok(await pollUntil(() => document.querySelectorAll(".navigator-item").length === 1 && !document.querySelector(".navigator-item mark")), "empty navigator search did not avoid match rendering for a large response");
    search.value = "needle"; search.dispatchEvent(new Event("input", { bubbles: true }));
    ok(await pollUntil(() => document.querySelector(".navigator-item mark")?.textContent === "Needle"), "navigator did not search a large response without pathological allocation");
    search.value = "body-only-needle"; window.__events.emit({ status: "complete", responses: [response("older", older), response("latest", latest)], latestId: "latest", revision: 6 });
    ok(await pollUntil(() => document.querySelector(".navigator-item")), "navigator did not restore results after the response list reset");
    document.querySelector(".navigator-item").focus(); const runningLatest = latest + "\\n\\nStreaming revision still has the body-only-needle.";
    window.__events.emit({ status: "running", responses: [response("older", older), response("latest", runningLatest, "running")], latestId: "latest", revision: 7 });
    ok(await pollUntil(() => body.textContent.includes("Streaming revision") && document.activeElement?.dataset.responseId === "latest" && document.querySelector(".navigator-item")?.getAttribute("aria-current") === "true"), "streaming latest response did not update visibly or navigator lost its focused result");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); ok(panel.open && document.activeElement === search, "Meta+K did not open and focus navigator search");
    search.value = ""; search.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector('.navigator-item[data-response-id="older"]').click();
    ok(await pollUntil(() => body.textContent.includes("Older body only")), "navigator result button did not select response");
    document.querySelector('.navigator-item[data-response-id="latest"]').click();
    ok(await pollUntil(() => body.textContent.includes("Streaming revision")), "navigator result button did not reselect the latest response");
    document.getElementById("copy-response").click();
    ok(await pollUntil(() => window.__copied.some(text => text.includes("Streaming revision")) && document.getElementById("copy-response").textContent === "Copied" && document.getElementById("status").textContent.includes("Copied")), "response Markdown copy lacked visible feedback");
    document.getElementById("download-response").click(); document.getElementById("download-history").click();
    ok(await pollUntil(() => window.__downloads.length >= 2), "the response/history downloads did not complete");
    const currentDownload = await window.__downloads[0].blob.text(), allDownload = await window.__downloads[1].blob.text();
    ok(currentDownload.includes("Streaming revision") && !currentDownload.includes("Older body only") && allDownload.indexOf("Older body only") < allDownload.indexOf("Streaming revision") && window.__downloads[1].name === "pi-response-history.md", "Markdown downloads did not target selected/all history in order");
    document.getElementById("print-response").click(); const surface = document.getElementById("print-surface");
    ok(document.body.dataset.printScope === "current" && !surface.hasAttribute("aria-hidden") && surface.children.length === 1 && surface.querySelector(".mermaid-host svg") && surface.querySelector(".tree-view") && surface.querySelector(".diff-view") && surface.querySelector(".json-view") && surface.querySelector(".csv-view"), "Print current did not expose and clone the decorated rich response");
    dispatchEvent(new Event("afterprint")); ok(surface.getAttribute("aria-hidden") === "true" && !surface.children.length && !document.body.dataset.printScope, "afterprint did not restore the hidden current print surface");
    document.getElementById("print-history").click(); ok(document.body.dataset.printScope === "all" && !surface.hasAttribute("aria-hidden") && surface.children.length === 2 && surface.children[0].textContent.includes("Older body only") && surface.children[1].textContent.includes("Streaming revision") && surface.children[1].classList.contains("print-break"), "Print all did not expose or preserve retained response count/order/page break");
    dispatchEvent(new Event("afterprint")); ok(window.__printCalls === 2 && surface.getAttribute("aria-hidden") === "true" && !surface.children.length && !document.body.dataset.printScope, "afterprint did not restore the hidden all-history print surface");
    window.__events.emit({ status: "complete", responses: [response("latest", runningLatest)], latestId: "latest", revision: 8 });
    ok(await pollUntil(() => document.querySelector('.navigator-item[data-response-id="latest"]') && !document.querySelector('.navigator-item[data-response-id="older"]') && body.textContent.includes("Streaming revision")), "navigator selection retention/eviction was incorrect");
    const limited = Array.from({ length: 65 }, (_, index) => "~~~json\\n{\\\"n\\\":" + index + "}\\n~~~").join("\\n\\n");
    window.__events.emit({ status: "complete", responses: [response("limited", limited)], latestId: "limited", revision: 9 });
    ok(await pollUntil(() => body.querySelectorAll(".json-view").length === 64 && body.querySelectorAll("pre").length === 1), "rich-fence count cap did not preserve literal fallback beyond boundary");
    const print = [...document.styleSheets[0].cssRules].find(rule => rule instanceof CSSMediaRule && rule.conditionText === "print"), printCss = [...print.cssRules].map(rule => rule.cssText).join(" ");
    ok(/\.toolbar[^}]*display: none/.test(printCss) && /\.code-actions[^}]*display: none/.test(printCss) && /pre[^}]*max-height: none/.test(printCss) && /\.diff-view[^}]*max-height: none[^}]*overflow: visible/.test(printCss), "print CSS does not hide controls and fully expand code/diffs");
    const contextNonce = "ctx-9f2d";
    const toolStep = result => JSON.stringify({ nonce: contextNonce, id: "call-1", name: "Read", summary: "a/b.ts", status: "ok", result: result, truncated: false });
    const thinkStep = JSON.stringify({ nonce: contextNonce, thinking: "internal reasoning", truncated: false });
    const forgedStep = JSON.stringify({ nonce: "forged", id: "call-2", name: "Write", summary: "z", status: "ok", result: "", truncated: false });
    const hostileResult = "<img src=x onerror=window.__pwned4=1>";
    const contextMarkdown = ["~~~pi-tool", toolStep(hostileResult), "~~~", "", "~~~pi-think", thinkStep, "~~~", "", "~~~pi-tool", forgedStep, "~~~"].join("\\n");
    window.__events.emit({ status: "complete", responses: [response("context", contextMarkdown)], latestId: "context", revision: 10, nonce: contextNonce });
    ok(await pollUntil(() => window.ResponseViewerNonce === contextNonce), "session nonce did not propagate from the snapshot to the renderers");
    const toolSteps = [...body.querySelectorAll(".tool-step")];
    ok(toolSteps.length === 1, "expected exactly one rendered tool-step chip for the valid-nonce fence");
    ok(toolSteps[0].querySelector(".tool-step-name")?.textContent === "Read", "tool-step name was not rendered from the payload");
    ok(toolSteps[0].parentElement?.classList.contains("context-block") && !toolSteps[0].parentElement.querySelector(".code-label"), "tool-step chip kept the code-block copy/wrap/expand chrome");
    ok(!body.querySelector("img,[onerror]") && window.__pwned4 === undefined, "hostile tool result became active DOM instead of literal text");
    ok(body.querySelectorAll(".context-block").length === 2, "only the nonce-matching tool/thinking fences became context blocks");
    const resultBody = toolSteps[0].querySelector(".tool-step-result pre");
    ok(resultBody?.textContent.includes(hostileResult), "hostile tool result text is shown literally in the result body");
    const thinkingView = body.querySelector(".thinking-view");
    ok(thinkingView instanceof HTMLDetailsElement && thinkingView.open === false, "thinking disclosure did not start collapsed");
    thinkingView.open = true;
    ok(await pollUntil(() => thinkingView.querySelector("pre").textContent.length > 0), "thinking content is present once the disclosure is expanded");
    ok([...body.querySelectorAll(".code-block")].some(block => block.textContent.includes('"forged"')), "forged-nonce fence did not fall back to a literal code block");
    const noNonceStep = JSON.stringify({ id: "call-3", name: "Grep", summary: "x", status: "ok", result: "", truncated: false });
    const noNonceMarkdown = ["~~~pi-tool", noNonceStep, "~~~"].join("\\n");
    window.__events.emit({ status: "complete", responses: [response("no-nonce", noNonceMarkdown)], latestId: "no-nonce", revision: 11 });
    ok(await pollUntil(() => window.ResponseViewerNonce === undefined), "test setup: session nonce should be unset when the snapshot omits it");
    ok(!document.querySelector(".tool-step"), "a payload omitting nonce rendered a chip when no session nonce was published");
    const shortPrompt = "why is it slow?";
    window.__events.emit({ status: "complete", responses: [response("prompt-short", "short answer", "complete", { text: shortPrompt, truncated: false })], latestId: "prompt-short", revision: 12 });
    ok(await pollUntil(() => body.querySelector(".response-prompt-text")?.textContent === shortPrompt), "prompt header text did not match the prompt");
    const shortHeader = body.querySelector(".response-prompt");
    ok(shortHeader?.classList.contains("response-prompt-open") && !shortHeader.querySelector(".response-prompt-toggle"), "a short prompt should render open with no toggle");
    ok(!shortHeader.querySelector(".response-prompt-cut"), "a non-truncated prompt rendered a truncation marker");
    const longPrompt = "line one\\nline two\\nline three\\nline four\\nline five";
    window.__events.emit({ status: "complete", responses: [response("prompt-long", "long answer", "complete", { text: longPrompt, truncated: false })], latestId: "prompt-long", revision: 13 });
    ok(await pollUntil(() => body.querySelector(".response-prompt-toggle")), "a long prompt did not render a truncation toggle");
    let longHeader = body.querySelector(".response-prompt"), toggle = longHeader?.querySelector(".response-prompt-toggle");
    ok(toggle && !longHeader.classList.contains("response-prompt-open") && toggle.textContent === "Show more" && toggle.getAttribute("aria-expanded") === "false", "a long prompt did not clamp behind a collapsed toggle");
    toggle.click();
    ok(longHeader.classList.contains("response-prompt-open") && toggle.textContent === "Show less" && toggle.getAttribute("aria-expanded") === "true", "the prompt toggle did not expand the header on click");
    // renderNow() replaces body.innerHTML on every markdown delta while a response streams; the
    // expanded state must survive that re-render for the same response id, not silently re-collapse.
    window.__events.emit({ status: "running", responses: [response("prompt-long", "long answer continues streaming", "running", { text: longPrompt, truncated: false })], latestId: "prompt-long", revision: 14 });
    ok(await pollUntil(() => body.textContent.includes("long answer continues streaming")), "the streaming re-render did not update the response body");
    longHeader = body.querySelector(".response-prompt"); toggle = longHeader?.querySelector(".response-prompt-toggle");
    ok(longHeader?.classList.contains("response-prompt-open") && toggle?.textContent === "Show less" && toggle?.getAttribute("aria-expanded") === "true", "the expanded prompt state did not survive a streaming re-render of the same response");
    // A different response id must start collapsed: expansion state is tracked per response, not globally.
    window.__events.emit({ status: "complete", responses: [response("prompt-long-2", "another long answer", "complete", { text: longPrompt, truncated: false })], latestId: "prompt-long-2", revision: 15 });
    ok(await pollUntil(() => body.textContent.includes("another long answer")), "the response for a different prompt id did not render");
    const otherHeader = body.querySelector(".response-prompt"), otherToggle = otherHeader?.querySelector(".response-prompt-toggle");
    ok(otherToggle && !otherHeader.classList.contains("response-prompt-open") && otherToggle.textContent === "Show more", "a different response id inherited another response's expanded prompt state");
    window.__events.emit({ status: "complete", responses: [response("prompt-truncated", "truncated prompt answer", "complete", { text: "cut here", truncated: true })], latestId: "prompt-truncated", revision: 16 });
    ok(await pollUntil(() => body.querySelector(".response-prompt-cut")?.textContent === "… prompt truncated, see terminal"), "a truncated prompt did not render a truncation marker");
    const hostilePrompt = "check <script>window.__promptPwned=1<\\/script> please";
    window.__events.emit({ status: "complete", responses: [response("prompt-hostile", "hostile answer", "complete", { text: hostilePrompt, truncated: false })], latestId: "prompt-hostile", revision: 17 });
    ok(await pollUntil(() => body.querySelector(".response-prompt-text")?.textContent === hostilePrompt && !body.querySelector(".response-prompt")?.querySelector("script") && window.__promptPwned === undefined), "hostile prompt text was not inserted inertly as literal text");
    // plainMarkdown() (export-view.js): exported/printed Markdown must flatten pi-tool/pi-think
    // fences whose nonce matches the live session nonce (taken from the published snapshot, not a
    // literal) into readable, literally-emitted text, while a fence carrying a foreign nonce is left
    // exactly as written. A tool result containing Markdown-looking text must survive as literal text.
    const backtick = String.fromCharCode(96);
    const exportFence = (kind, payload) => backtick + backtick + backtick + kind + "\\n" + JSON.stringify(payload) + "\\n" + backtick + backtick + backtick;
    const exportNonceValue = "export-" + Math.random().toString(36).slice(2);
    const exportPrompt = "why is **this** slow?\\n# investigate";
    const exportResult = "**bold** text\\n# Heading\\n" + backtick + backtick + backtick + "js\\nconst x = 1;\\n" + backtick + backtick + backtick;
    const exportToolFence = exportFence("pi-tool", { nonce: exportNonceValue, id: "call-export", name: "Read", summary: "a/b.ts", status: "ok", result: exportResult, truncated: false });
    const exportThinkFence = exportFence("pi-think", { nonce: exportNonceValue, thinking: "internal reasoning about **bold** stuff", truncated: false });
    const foreignFence = exportFence("pi-tool", { nonce: "totally-different-nonce", id: "call-foreign", name: "Write", summary: "z", status: "ok", result: "unchanged", truncated: false });
    const exportMatchMarkdown = [exportToolFence, "", exportThinkFence].join("\\n");
    window.__events.emit({ status: "complete", responses: [response("export-match", exportMatchMarkdown, "complete", { text: exportPrompt, truncated: false }), response("export-foreign", foreignFence)], latestId: "export-match", revision: 18, nonce: exportNonceValue });
    ok(await pollUntil(() => window.ResponseViewerNonce === exportNonceValue), "test setup: export nonce did not propagate to the client");
    const downloadsBefore = window.__downloads.length;
    document.getElementById("download-history").click();
    ok(await pollUntil(() => window.__downloads.length > downloadsBefore), "download-history did not produce a download");
    const exported = await window.__downloads[downloadsBefore].blob.text();
    ok(!exported.includes(exportNonceValue), "the session nonce leaked into exported markdown");
    ok(!exported.includes("pi-think"), "a matched-nonce pi-think fence was not flattened out of exported markdown");
    ok(exported.split("pi-tool").length - 1 === 1, "exported markdown should flatten the matched-nonce tool step and leave only the foreign-nonce fence's literal pi-tool marker");
    ok(exported.includes("why is **this** slow?") && exported.includes("# investigate"), "the prompt did not appear in exported markdown");
    ok(exported.includes("Read") && exported.includes("a/b.ts") && exported.includes("\\u2713 Read"), "the tool step did not become readable text in exported markdown");
    ok(exported.includes("internal reasoning about **bold** stuff"), "the thinking block did not become readable text in exported markdown");
    ok(exported.includes("    **bold** text") && exported.includes("    # Heading") && exported.includes("    " + backtick + backtick + backtick + "js"), "a tool result containing Markdown was not emitted as a literal indented block");
    document.getElementById("print-history").click();
    ok(await pollUntil(() => surface.querySelectorAll(".print-response").length > 0), "print-history did not populate the print surface");
    const exportArticle = [...surface.querySelectorAll(".print-response")][0];
    ok(exportArticle?.textContent.includes("**bold** text") && exportArticle.textContent.includes("# Heading") && !exportArticle.querySelector("h1,h2,h3,h4,h5,h6"), "print-all rendered tool-result Markdown as live formatting instead of literal text");
    ok(exportArticle?.textContent.includes("why is **this** slow?"), "print-all did not include the exported prompt text");
    dispatchEvent(new Event("afterprint"));
    // Fix round 1, finding 1: a newline in a tool name is the one export value interpolated
    // straight into markdown bold syntax, and CommonMark lets a heading interrupt a paragraph,
    // so an un-flattened newline followed by "# …" would inject a real heading into the export.
    const injectionNonceValue = "export-inj-" + Math.random().toString(36).slice(2);
    const injectionFence = exportFence("pi-tool", { nonce: injectionNonceValue, id: "call-inj", name: "Read\\n# Injected", summary: "x", status: "ok", result: "", truncated: false });
    window.__events.emit({ status: "complete", responses: [response("export-injection", injectionFence)], latestId: "export-injection", revision: 19, nonce: injectionNonceValue });
    ok(await pollUntil(() => window.ResponseViewerNonce === injectionNonceValue), "test setup: injection nonce did not propagate to the client");
    const injectionDownloadsBefore = window.__downloads.length;
    document.getElementById("download-history").click();
    ok(await pollUntil(() => window.__downloads.length > injectionDownloadsBefore), "download-history did not produce a download for the injection test");
    const injectionExported = await window.__downloads[injectionDownloadsBefore].blob.text();
    ok(injectionExported.includes("Read # Injected") && !injectionExported.includes("Read\\n# Injected"), "a newline in a tool name was not flattened to one line in exported markdown");
    document.getElementById("print-history").click();
    ok(await pollUntil(() => surface.querySelectorAll(".print-response").length > 0), "print-history did not populate the print surface for the injection test");
    const injectionArticle = [...surface.querySelectorAll(".print-response")][0];
    ok(injectionArticle?.textContent.includes("Read # Injected") && !injectionArticle.querySelector("h1,h2,h3,h4,h5,h6"), "a newline in a tool name injected a real heading into the print-all rendering");
    dispatchEvent(new Event("afterprint"));
    // Fix round 1, finding 2: the live reader surfaces truncation for the prompt, a thinking block,
    // and a tool result; exported/printed Markdown must say so too, or cut content reads as complete.
    const truncNonceValue = "export-trunc-" + Math.random().toString(36).slice(2);
    const truncToolFence = exportFence("pi-tool", { nonce: truncNonceValue, id: "call-trunc", name: "Bash", summary: "npm test", status: "ok", result: "partial output", truncated: true });
    const truncThinkFence = exportFence("pi-think", { nonce: truncNonceValue, thinking: "partial thought", truncated: true });
    const notTruncToolFence = exportFence("pi-tool", { nonce: truncNonceValue, id: "call-full", name: "Bash", summary: "ls", status: "ok", result: "full output", truncated: false });
    const truncMarkdown = [truncToolFence, "", truncThinkFence, "", notTruncToolFence].join("\\n");
    window.__events.emit({ status: "complete", responses: [response("export-trunc", truncMarkdown, "complete", { text: "trunc prompt", truncated: true })], latestId: "export-trunc", revision: 20, nonce: truncNonceValue });
    ok(await pollUntil(() => window.ResponseViewerNonce === truncNonceValue), "test setup: truncation nonce did not propagate to the client");
    const truncDownloadsBefore = window.__downloads.length;
    document.getElementById("download-history").click();
    ok(await pollUntil(() => window.__downloads.length > truncDownloadsBefore), "download-history did not produce a download for the truncation test");
    const truncExported = await window.__downloads[truncDownloadsBefore].blob.text();
    ok(truncExported.includes("trunc prompt") && truncExported.includes("partial thought") && truncExported.includes("partial output") && truncExported.includes("full output"), "truncation test setup content was missing from the export");
    ok(truncExported.split("… truncated, see terminal").length - 1 === 3, "expected exactly three truncation notes: the prompt, the thinking block, and the truncated tool result, and none for the untruncated tool result");
    // Fix round 1, finding 4: copy-response and download-response (the "current response" paths)
    // were only exercised earlier against fence-free content; exercise them against a fence-bearing
    // response too so a regression isolated to either call site would actually be caught.
    const currentNonceValue = "export-cur-" + Math.random().toString(36).slice(2);
    const currentToolFence = exportFence("pi-tool", { nonce: currentNonceValue, id: "call-current", name: "Grep", summary: "TODO", status: "ok", result: "3 matches", truncated: false });
    window.__events.emit({ status: "complete", responses: [response("export-current", currentToolFence)], latestId: "export-current", revision: 21, nonce: currentNonceValue });
    ok(await pollUntil(() => window.ResponseViewerNonce === currentNonceValue), "test setup: current-response nonce did not propagate to the client");
    const copiedBefore = window.__copied.length;
    document.getElementById("copy-response").click();
    ok(await pollUntil(() => window.__copied.length > copiedBefore), "copy-response did not complete for the fence-bearing current response");
    const copiedText = window.__copied[copiedBefore];
    ok(copiedText && !copiedText.includes(currentNonceValue) && !copiedText.includes("pi-tool") && copiedText.includes("Grep") && copiedText.includes("TODO"), "copy-response leaked a nonce or a raw pi-tool fence, or dropped the flattened tool step");
    const downloadsBeforeCurrent = window.__downloads.length;
    document.getElementById("download-response").click();
    ok(await pollUntil(() => window.__downloads.length > downloadsBeforeCurrent), "download-response did not produce a download for the fence-bearing current response");
    const currentDownloadText = await window.__downloads[downloadsBeforeCurrent].blob.text();
    ok(!currentDownloadText.includes(currentNonceValue) && !currentDownloadText.includes("pi-tool") && currentDownloadText.includes("Grep") && currentDownloadText.includes("TODO"), "download-response leaked a nonce or a raw pi-tool fence, or dropped the flattened tool step");
    document.title = "PASS: response viewer browser smoke";
  } catch (error) { document.title = "FAIL: " + (error instanceof Error ? error.message : String(error)); }
})();
</script>`;
		const source = template
			.replaceAll('src="vendor/', `src="${asset("vendor/")}`)
			.replaceAll('src="link-policy.js"', `src="${asset("link-policy.js")}"`)
			.replaceAll('src="renderer.js"', `src="${asset("renderer.js")}"`)
			.replaceAll('src="syntax.js"', `src="${asset("syntax.js")}"`)
			.replaceAll('src="mermaid-view.js"', `src="${asset("mermaid-view.js")}"`)
			.replaceAll('src="tree-view.js"', `src="${asset("tree-view.js")}"`)
			.replaceAll('src="fence-renderers.js"', `src="${asset("fence-renderers.js")}"`)
			.replaceAll('src="diff-view.js"', `src="${asset("diff-view.js")}"`)
			.replaceAll('src="json-view.js"', `src="${asset("json-view.js")}"`)
			.replaceAll('src="csv-view.js"', `src="${asset("csv-view.js")}"`)
			.replaceAll('src="tool-step-view.js"', `src="${asset("tool-step-view.js")}"`)
			.replaceAll('src="thinking-view.js"', `src="${asset("thinking-view.js")}"`)
			.replaceAll('src="navigator.js"', `src="${asset("navigator.js")}"`)
			.replaceAll('src="export-view.js"', `src="${asset("export-view.js")}"`)
			.replaceAll('src="client.js"', `src="${asset("client.js")}"`)
			.replace('  <script src="' + asset("vendor/marked-18.0.5.umd.js") + '">', `${prelude}\n  <script src="${asset("vendor/marked-18.0.5.umd.js")}">`)
			.replace("</body>", `${smoke}</body>`);
		await writeFile(file, source);
		const { stdout } = await execFile(chrome, ["--headless=new", "--window-size=1440,1000", "--dump-dom", "--run-all-compositor-stages-before-draw", "--virtual-time-budget=60000", "--allow-file-access-from-files", "--disable-background-networking", "--disable-component-update", "--use-mock-keychain", "--password-store=basic", pathToFileURL(file).href], { timeout: 120_000, maxBuffer: 5 * 1024 * 1024 });
		const title = stdout.match(/<title>([\s\S]*?)<\/title>/i)?.[1];
		assert.equal(title, "PASS: response viewer browser smoke", `browser smoke failed: ${title ?? "missing title"}`);
		console.log(title);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
