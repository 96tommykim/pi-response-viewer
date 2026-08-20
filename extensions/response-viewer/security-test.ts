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
Element.prototype.scrollIntoView = function(options) { window.__scrollTarget = this; window.__scrollOptions = options; };
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
    const mermaidHost = validMermaidBlock.querySelector(".mermaid-host"), mermaidSvg = mermaidHost.querySelector("svg");
    const scaleOf = element => { const tail = element.style.transform.split("scale(")[1]; return tail ? Number(tail.split(")")[0]) : 1; };
    const zoomButtons = [...mermaidHost.querySelectorAll(".mermaid-controls button")];
    ok(zoomButtons.length === 4, "mermaid zoom controls did not render");
    const hostBox = mermaidHost.getBoundingClientRect();
    const wheel = init => mermaidHost.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: hostBox.left + 12, clientY: hostBox.top + 12, ...init }));
    ok(wheel({ deltaY: -300 }) === true && scaleOf(mermaidSvg) === 1, "a plain wheel over a diagram zoomed instead of scrolling the page");
    wheel({ deltaY: -300, ctrlKey: true });
    ok(scaleOf(mermaidSvg) > 1.4 && mermaidHost.classList.contains("mermaid-zoomed"), "ctrl+wheel did not zoom the diagram: " + mermaidSvg.style.transform);
    const zoomedTransform = mermaidSvg.style.transform;
    mermaidHost.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1, clientX: 60, clientY: 60 }));
    mermaidHost.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, buttons: 1, clientX: 110, clientY: 95 }));
    mermaidHost.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    ok(mermaidSvg.style.transform !== zoomedTransform && scaleOf(mermaidSvg) > 1.4 && !mermaidHost.classList.contains("mermaid-panning"), "dragging a zoomed diagram did not pan it");
    zoomButtons.find(button => button.textContent === "Fit").click();
    ok(scaleOf(mermaidSvg) === 1 && mermaidSvg.style.transform.includes("translate(0px, 0px)") && !mermaidHost.classList.contains("mermaid-zoomed"), "Fit did not reset the diagram transform");
    const zoomIn = zoomButtons.find(button => button.textContent === "+"), zoomOut = zoomButtons.find(button => button.textContent === "\u2212");
    zoomIn.click();
    ok(scaleOf(mermaidSvg) > 1, "the zoom-in button did not scale the diagram");
    zoomOut.click();
    ok(scaleOf(mermaidSvg) === 1 && !mermaidHost.classList.contains("mermaid-zoomed"), "matched zoom steps drifted off 100%: " + mermaidSvg.style.transform);
    zoomIn.click(); zoomIn.click(); zoomIn.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    ok(scaleOf(mermaidSvg) > 1, "a double-click on the zoom button reset the diagram");
    mermaidHost.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 2, button: 0, buttons: 1, clientX: 60, clientY: 60 }));
    mermaidHost.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 2, buttons: 0, clientX: 200, clientY: 200 }));
    const releasedTransform = mermaidSvg.style.transform;
    mermaidHost.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 2, buttons: 0, clientX: 400, clientY: 400 }));
    ok(mermaidSvg.style.transform === releasedTransform && !mermaidHost.classList.contains("mermaid-panning"), "a released drag kept panning the diagram");
    const gentleStart = scaleOf(mermaidSvg);
    for (let step = 0; step < 4; step += 1) wheel({ deltaY: -2, ctrlKey: true });
    ok(scaleOf(mermaidSvg) > gentleStart + 0.01, "a gentle pinch did not accumulate zoom: " + mermaidSvg.style.transform);
    mermaidHost.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    ok(scaleOf(mermaidSvg) === 1, "double-click did not reset the diagram");
    ok(await pollUntil(() => hostileMermaidBlock.querySelector(".mermaid-host svg")), "hostile mermaid diagram did not render an svg");
    const hostileSvg = hostileMermaidBlock.querySelector(".mermaid-host svg");
    ok(!hostileSvg.querySelector("foreignObject") && !hostileSvg.innerHTML.includes("onerror") && window.__pwned === undefined, "hostile Mermaid retained active content");
    const anchorHref = anchor => anchor.getAttribute("href") ?? anchor.getAttribute("xlink:href") ?? "";
    ok(![...hostileSvg.querySelectorAll("a")].some(anchor => anchorHref(anchor).toLowerCase().startsWith("javascript:")), "javascript: Mermaid link survived");
    const externalAnchor = [...hostileSvg.querySelectorAll("a")].find(anchor => anchorHref(anchor).includes("evil.example"));
    ok(externalAnchor?.getAttribute("rel") === "noreferrer noopener" && externalAnchor.getAttribute("target") === "_blank", "external Mermaid link protection missing");
    await wait(250); ok(!brokenMermaidBlock.querySelector(".mermaid-host svg") && !brokenMermaidBlock.querySelector("pre").hidden, "broken Mermaid did not fall back");
    document.getElementById("previous-response").click(); await wait(40); document.getElementById("next-response").click();
    ok(await pollUntil(() => document.querySelector(".mermaid-host svg") && document.querySelector(".mermaid-host .mermaid-controls")), "cached Mermaid redraw did not inject after attachment or lost its zoom controls");
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
    ok(document.title.includes(shortPrompt), "the browser tab title did not name the turn by its prompt");
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
    const truncToolFence = exportFence("pi-tool", { nonce: truncNonceValue, id: "call-trunc", name: "Bash", summary: "node --test", status: "ok", result: "partial output", truncated: true });
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
    // Final review, finding 1: concise() skipped only the fence DELIMITER lines, so for a turn that
    // opens with thinking or a tool call the next non-blank line is the fence payload — whose first key
    // is the session nonce. That string became the browser tab title and the navigator preview.
    const titleNonceValue = "title-" + Math.random().toString(36).slice(2);
    const titleMarkdown = [exportFence("pi-think", { nonce: titleNonceValue, thinking: "read state.ts first", truncated: false }), "", exportFence("pi-tool", { nonce: titleNonceValue, id: "call-title", name: "Read", summary: "state.ts", status: "ok", result: "file body", truncated: false })].join("\\n");
    window.__events.emit({ status: "complete", responses: [response("title-leak", titleMarkdown)], latestId: "title-leak", revision: 22, nonce: titleNonceValue });
    ok(await pollUntil(() => window.ResponseViewerNonce === titleNonceValue && body.querySelector(".thinking-view")), "test setup: the nonce-leak fixture did not render its viewer fences");
    ok(!document.title.includes(titleNonceValue), "the session nonce leaked into document.title");
    ok(panel.open, "test setup: the navigator must be open for its labels to be in the DOM");
    const navigatorLabels = [...document.querySelectorAll(".navigator-title, .navigator-detail")];
    ok(navigatorLabels.length > 0, "test setup: the navigator rendered no labels");
    ok(!navigatorLabels.some(node => node.textContent.includes(titleNonceValue)), "the session nonce leaked into a navigator label");
    // Final review, finding 2: past MAX_TOOL_FENCES (256 in client.js) the renderer declines, and the
    // fence fell through to the ordinary code-block branch — printing the raw payload, nonce first,
    // with a working Copy button. An over-budget viewer fence must degrade to a neutral placeholder.
    const overflowNonceValue = "overflow-" + Math.random().toString(36).slice(2);
    const overflowFences = Array.from({ length: 257 }, (_, index) => exportFence("pi-tool", { nonce: overflowNonceValue, id: "of-" + index, name: "Read", summary: "f" + index + ".ts", status: "ok", result: "", truncated: false }));
    overflowFences.push(exportFence("pi-think", { nonce: overflowNonceValue, thinking: "over the budget", truncated: false }));
    window.__events.emit({ status: "complete", responses: [response("overflow", overflowFences.join("\\n\\n"))], latestId: "overflow", revision: 23, nonce: overflowNonceValue });
    ok(await pollUntil(() => body.querySelectorAll(".tool-step").length === 256), "the tool-fence budget did not render exactly MAX_TOOL_FENCES chips");
    const hiddenNotes = [...body.querySelectorAll(".context-hidden")];
    ok(hiddenNotes.length === 2, "the two over-budget viewer fences did not render placeholders");
    ok(hiddenNotes[0].textContent === "Tool step hidden (viewer limit reached)" && hiddenNotes[1].textContent === "Thinking hidden (viewer limit reached)", "the over-budget placeholders did not carry the neutral per-kind text");
    ok(!body.textContent.includes(overflowNonceValue), "an over-budget viewer fence printed its raw payload, nonce included");
    ok(hiddenNotes.every(note => note.parentElement.classList.contains("context-block") && !note.parentElement.querySelector("button")), "an over-budget viewer fence kept its code-block chrome or its Copy button");
    ok(!body.querySelector(".thinking-view"), "the over-budget thinking fence rendered a disclosure instead of a placeholder");
    // Final review, finding 4: response-level truncation (whole earlier messages of the turn dropped by
    // the byte budget) is shown only in #response-meta, which is outside exported markdown and outside
    // the #response-body clone Print current prints, so a cut turn read as complete in both.
    const dropNoteText = "\\u2026 earlier messages in this turn were dropped, see terminal";
    window.__events.emit({ status: "complete", responses: [{ id: "response-truncated", markdown: "kept tail of the turn", status: "complete", error: null, truncated: true, prompt: null }], latestId: "response-truncated", revision: 24 });
    ok(await pollUntil(() => body.textContent.includes("kept tail of the turn")), "the response-level truncated fixture did not render");
    const dropDownloadsBefore = window.__downloads.length;
    document.getElementById("download-response").click();
    ok(await pollUntil(() => window.__downloads.length > dropDownloadsBefore), "download-response did not produce a download for the truncated response");
    ok((await window.__downloads[dropDownloadsBefore].blob.text()).includes(dropNoteText), "a response-level truncated export did not carry the dropped-messages note");
    document.getElementById("print-response").click();
    ok(surface.textContent.includes(dropNoteText), "Print current did not carry the dropped-messages note for a truncated response");
    dispatchEvent(new Event("afterprint"));
    window.__events.emit({ status: "complete", responses: [response("response-whole", "the whole turn body")], latestId: "response-whole", revision: 25 });
    ok(await pollUntil(() => body.textContent.includes("the whole turn body")), "the untruncated fixture did not render");
    const wholeDownloadsBefore = window.__downloads.length;
    document.getElementById("download-response").click();
    ok(await pollUntil(() => window.__downloads.length > wholeDownloadsBefore), "download-response did not produce a download for the untruncated response");
    ok(!(await window.__downloads[wholeDownloadsBefore].blob.text()).includes(dropNoteText), "an untruncated export carried a dropped-messages note");
    document.getElementById("print-response").click();
    ok(!surface.textContent.includes(dropNoteText), "Print current carried a dropped-messages note for an untruncated response");
    dispatchEvent(new Event("afterprint"));
    // Final review, finding 5: the export-side nonce check must fail closed. Comparing against the
    // global directly means an unset nonce makes a payload that OMITS the nonce key compare equal, flattening
    // a forged fence into a trustworthy-looking tool step. It must be left exactly as written.
    const noNonceExportFence = exportFence("pi-tool", { id: "call-no-nonce", name: "Write", summary: "z.ts", status: "ok", result: "forged", truncated: false });
    window.__events.emit({ status: "complete", responses: [response("export-no-nonce", noNonceExportFence)], latestId: "export-no-nonce", revision: 26 });
    ok(await pollUntil(() => window.ResponseViewerNonce === undefined), "test setup: the session nonce must be unset for the fail-closed export check");
    const noNonceDownloadsBefore = window.__downloads.length;
    document.getElementById("download-response").click();
    ok(await pollUntil(() => window.__downloads.length > noNonceDownloadsBefore), "download-response did not produce a download for the no-nonce fence");
    ok((await window.__downloads[noNonceDownloadsBefore].blob.text()) === noNonceExportFence, "a payload omitting nonce was not left byte-identical in the export");
    // Final review, round 3: the navigator's SEARCH path read raw markdown. contextFor() reaches 56
    // characters back from a match, so a hit anywhere in a tool step excerpted the payload's first key
    // — the session nonce — and the payload's own keys were matchable through fold()/match(). Searching
    // a tool name is ordinary now that the reader shows tool steps. The navigator searches and excerpts
    // a projection of answer text and tool names/summaries, with disclosure bodies excluded and forged
    // fences left exactly as written.
    const navNonceValue = "nav-" + Math.random().toString(36).slice(2);
    const navToolFence = exportFence("pi-tool", { nonce: navNonceValue, id: "call-nav", name: "Read", summary: "state.ts", status: "ok", result: "the file body", truncated: false });
    const navThinkFence = exportFence("pi-think", { nonce: navNonceValue, thinking: "considering the parser", truncated: false });
    const navForgedFence = exportFence("pi-tool", { nonce: "forged-nav-nonce", id: "call-forged", name: "Writefile", summary: "zzz.ts", status: "ok", result: "", truncated: false });
    window.__events.emit({ status: "complete", responses: [response("nav-search", [navToolFence, "", navThinkFence, "", navForgedFence].join("\\n"))], latestId: "nav-search", revision: 27, nonce: navNonceValue });
    ok(await pollUntil(() => window.ResponseViewerNonce === navNonceValue), "test setup: navigator-search nonce did not propagate to the client");
    ok(panel.open, "test setup: the navigator must be open for its excerpts to be in the DOM");
    const searchExcerpt = async (query, label) => {
      search.value = query; search.dispatchEvent(new Event("input", { bubbles: true }));
      ok(await pollUntil(() => document.querySelectorAll(".navigator-item").length === 1), label + ": the search did not match the response");
      return document.querySelector(".navigator-detail").textContent;
    };
    const toolExcerpt = await searchExcerpt("read", "tool-name search");
    ok(!toolExcerpt.includes(navNonceValue), "searching a tool name leaked the session nonce into the navigator excerpt");
    ok(toolExcerpt.includes("Read") && toolExcerpt.includes("state.ts"), "searching a tool name lost the step's name/summary from the excerpt");
    search.value = "considering"; search.dispatchEvent(new Event("input", { bubbles: true }));
    ok(await pollUntil(() => !document.querySelector(".navigator-item")), "a Thinking body was searchable in the navigator");
    const forgedExcerpt = await searchExcerpt("Writefile", "forged-fence search");
    ok(!forgedExcerpt.includes(navNonceValue), "a forged fence's excerpt leaked the session nonce");
    ok(forgedExcerpt.includes("Writefile") && forgedExcerpt.includes("forged-nav-nonce"), "a forged fence was flattened instead of staying literal in the navigator excerpt");
    // The payload's own keys must no longer be matchable: they are not text the reader ever shows.
    search.value = "nonce"; search.dispatchEvent(new Event("input", { bubbles: true }));
    ok(await pollUntil(() => [...document.querySelectorAll(".navigator-detail")].every(node => !node.textContent.includes(navNonceValue))), "searching the word nonce surfaced the session nonce");
    search.value = ""; search.dispatchEvent(new Event("input", { bubbles: true }));
    // Match-level navigation keeps the nonce-safe projection, but moves among individual hits in
    // response order and marks only the rendered response content — never navigator or toolbar text.
    const matchNonceValue = "match-" + Math.random().toString(36).slice(2);
    const matchThinkingFence = exportFence("pi-think", { nonce: matchNonceValue, thinking: "thinking needle", truncated: false });
    const matchToolFence = exportFence("pi-tool", { nonce: matchNonceValue, id: "call-match", name: "Read", summary: "state.ts", status: "ok", result: "tool needle", truncated: false });
    const matchOne = "# One\\n\\nneedle first\\n\\nneedle second";
    const matchTwo = ["# Two", "plain needle", matchThinkingFence, matchToolFence].join("\\n\\n");
    window.__events.emit({ status: "complete", responses: [response("match-one", matchOne), response("match-two", matchTwo)], latestId: "match-two", revision: 28, nonce: matchNonceValue });
    ok(await pollUntil(() => body.textContent.includes("plain needle") && window.ResponseViewerNonce === matchNonceValue), "match-navigation fixture did not render");
    const previousMatch = document.getElementById("previous-match"), nextMatch = document.getElementById("next-match"), matchControls = document.getElementById("navigator-match-controls"), matchCount = document.getElementById("navigator-match-count");
    // Body content stays out of search even after users manually expand the disclosures.
    const matchThinking = body.querySelector(".thinking-view"), matchToolResult = body.querySelector(".tool-step-result");
    ok(matchThinking instanceof HTMLDetailsElement && matchToolResult instanceof HTMLDetailsElement, "search-scope fixture did not render its disclosures");
    matchThinking.open = true; matchToolResult.open = true;
    search.value = "thinking needle"; search.dispatchEvent(new Event("input", { bubbles: true }));
    ok(matchCount.textContent === "0 of 0 matches" && !document.querySelector(".navigator-item"), "an expanded Thinking body was searchable");
    search.value = "tool needle"; search.dispatchEvent(new Event("input", { bubbles: true }));
    ok(matchCount.textContent === "0 of 0 matches" && !document.querySelector(".navigator-item"), "an expanded Tool Result body was searchable");
    search.value = "Readstate.ts"; search.dispatchEvent(new Event("input", { bubbles: true }));
    ok(matchCount.textContent === "0 of 0 matches" && !document.querySelector(".navigator-item"), "tool-row flex spacing was missing from the searchable projection");
    search.value = "Read state.ts"; search.dispatchEvent(new Event("input", { bubbles: true })); nextMatch.click();
    ok(await pollUntil(() => [...body.querySelectorAll("mark.response-search-match")].map(mark => mark.textContent).join("") === "Read state.ts"), "a semantic space between tool name and summary was not searchable");
    search.value = "needle"; search.dispatchEvent(new Event("input", { bubbles: true }));
    ok(!matchControls.hidden && !previousMatch.disabled && !nextMatch.disabled && matchCount.textContent === "0 of 3 matches", "non-empty search did not expose enabled match controls with an honest answer-only count");
    document.querySelector('.navigator-item[data-response-id="match-one"]').click();
    ok(await pollUntil(() => body.textContent.includes("needle first") && body.querySelector("mark.response-search-match")?.textContent === "needle"), "clicking a filtered response did not select and highlight its first match");
    ok(matchCount.textContent === "1 of 3 matches" && window.__scrollTarget?.classList.contains("response-search-match"), "click-to-first-match did not update the position or scroll target");
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    ok(await pollUntil(() => matchCount.textContent === "2 of 3 matches" && body.textContent.includes("needle second")), "Enter did not advance to the next occurrence in the same response");
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    ok(await pollUntil(() => matchCount.textContent === "1 of 3 matches"), "Shift+Enter did not return to the previous occurrence");
    nextMatch.click();
    ok(await pollUntil(() => matchCount.textContent === "2 of 3 matches"), "Next match button did not navigate");
    nextMatch.click();
    ok(await pollUntil(() => body.textContent.includes("plain needle") && matchCount.textContent === "3 of 3 matches"), "navigation did not continue into the next retained response");
    nextMatch.click();
    ok(await pollUntil(() => matchCount.textContent === "1 of 3 matches" && body.textContent.includes("needle first")), "match navigation did not cycle across retained responses");
    window.__events.emit({ status: "running", responses: [response("match-one", matchOne + "\\n\\nstreamed needle", "running"), response("match-two", matchTwo)], latestId: "match-one", revision: 29, nonce: matchNonceValue });
    ok(await pollUntil(() => body.textContent.includes("streamed needle") && matchCount.textContent === "1 of 4 matches" && body.querySelector("mark.response-search-match")?.textContent === "needle"), "streaming update did not rerender the selected response and preserve its highlight");
    const matchDownloadsBefore = window.__downloads.length;
    document.getElementById("download-response").click();
    ok(await pollUntil(() => window.__downloads.length > matchDownloadsBefore), "search-state download did not complete");
    ok(!(await window.__downloads[matchDownloadsBefore].blob.text()).includes("response-search-match"), "search markup leaked into downloaded Markdown");
    document.getElementById("print-response").click();
    ok(!surface.querySelector("mark.response-search-match"), "search markup leaked into Print current");
    dispatchEvent(new Event("afterprint"));
    search.value = matchNonceValue; search.dispatchEvent(new Event("input", { bubbles: true }));
    ok(matchCount.textContent === "0 of 0 matches" && !body.querySelector("mark.response-search-match") && !document.title.includes(matchNonceValue) && ![...document.querySelectorAll(".navigator-title,.navigator-detail")].some(node => node.textContent.includes(matchNonceValue)), "match navigation exposed the session nonce");
    const cappedMatches = Array.from({ length: 501 }, () => "needle").join(" ");
    window.__events.emit({ status: "complete", responses: [response("match-capped", cappedMatches)], latestId: "match-capped", revision: 30, nonce: matchNonceValue });
    ok(await pollUntil(() => body.textContent.includes("needle")), "capped-match fixture did not render");
    search.value = "needle"; search.dispatchEvent(new Event("input", { bubbles: true }));
    ok(matchCount.textContent === "0 of 500+ matches", "the visible match cap was not disclosed honestly");
    search.value = ""; search.dispatchEvent(new Event("input", { bubbles: true }));
    ok(matchControls.hidden && previousMatch.disabled && nextMatch.disabled && !body.querySelector("mark.response-search-match"), "clearing search did not reset match controls and highlights");
    // Empty-query previews stay useful without rendering a detached search projection, and remain
    // unchanged after a query has built then released that projection.
    const previewNonce = "preview-" + Math.random().toString(36).slice(2), ordinaryPreview = "Useful no-heading preview needle stays stable.";
    window.__events.emit({ status: "complete", responses: [response("ordinary-preview", ordinaryPreview)], latestId: "ordinary-preview", revision: 31, nonce: previewNonce });
    ok(await pollUntil(() => document.querySelector(".navigator-detail")?.textContent.includes(ordinaryPreview)), "an ordinary no-heading response lost its empty-query preview");
    const previewBeforeSearch = document.querySelector(".navigator-detail").textContent;
    ok(!previewBeforeSearch.includes(previewNonce), "the empty-query preview exposed the session nonce");
    search.value = "needle"; search.dispatchEvent(new Event("input", { bubbles: true }));
    const previewDuringSearch = document.querySelector(".navigator-detail").textContent;
    search.value = ""; search.dispatchEvent(new Event("input", { bubbles: true }));
    const previewAfterSearch = document.querySelector(".navigator-detail").textContent;
    ok(previewDuringSearch === previewBeforeSearch && previewAfterSearch === previewBeforeSearch && !previewAfterSearch.includes(previewNonce), "an ordinary preview changed after search projection or clearing");
    // The searchable projection is rendered text: links contribute labels but never destinations,
    // and ranges include overlapping Unicode-folded occurrences without rescanning the source.
    const linkFixture = "[visible needle](https://needle.invalid)\\n\\n[visible label](https://url-only.invalid/needle)\\n\\n~~~javascript\\nconst crossTokenNeedle = true;\\n~~~";
    window.__events.emit({ status: "complete", responses: [response("visible-projection", linkFixture)], latestId: "visible-projection", revision: 32 });
    ok(await pollUntil(() => body.textContent.includes("crossTokenNeedle")), "visible-projection fixture did not render");
    search.value = "needle.invalid"; search.dispatchEvent(new Event("input", { bubbles: true }));
    ok(matchCount.textContent === "0 of 0 matches" && !document.querySelector(".navigator-item"), "a Markdown link destination was indexed as visible text");
    search.value = "visible needle"; search.dispatchEvent(new Event("input", { bubbles: true })); nextMatch.click();
    ok(await pollUntil(() => body.querySelector("mark.response-search-match")?.textContent === "visible needle"), "a visible Markdown link label was not navigable");
    search.value = "const crossToken"; search.dispatchEvent(new Event("input", { bubbles: true })); nextMatch.click();
    ok(await pollUntil(() => [...body.querySelectorAll("mark.response-search-match")].map(mark => mark.textContent).join("") === "const crossToken"), "a match spanning Prism text nodes was not fully highlighted");
    const overlap = window.ResponseViewerNavigator.ranges(window.ResponseViewerNavigator.foldedText("aaa"), window.ResponseViewerNavigator.foldedNeedle("aa"));
    ok(overlap.length === 2 && overlap[1].start === 1, "callable folded range enumeration lost overlapping matches");
    const searchStarted = performance.now(), performanceRanges = window.ResponseViewerNavigator.ranges(window.ResponseViewerNavigator.foldedText("x".repeat(200_000) + " needle".repeat(501)), window.ResponseViewerNavigator.foldedNeedle("needle"));
    ok(performanceRanges.length === 501 && performance.now() - searchStarted < 2_000, "bounded match enumeration regressed to repeated full-source scans");
    // A malformed matching-nonce payload and an over-budget valid payload are private like the body:
    // neither source nor nonce may be searchable or previewable.
    const privateNonce = "private-" + Math.random().toString(36).slice(2);
    const malformedPrivate = ["~~~pi-tool", "{\\\"nonce\\\":\\\"" + privateNonce + "\\\",\\\"name\\\":\\\"private-secret\\\"", "~~~"].join("\\n");
    const overflowPrivate = Array.from({ length: 257 }, (_, index) => exportFence("pi-tool", { nonce: privateNonce, id: "private-" + index, name: "Read", summary: "f" + index, status: "ok", result: index === 256 ? "overflow-secret" : "ordinary", truncated: false })).join("\\n\\n");
    window.__events.emit({ status: "complete", responses: [response("private-malformed", malformedPrivate), response("private-overflow", overflowPrivate)], latestId: "private-overflow", revision: 33, nonce: privateNonce });
    ok(await pollUntil(() => body.querySelectorAll(".tool-step").length === 256), "private-fence overflow fixture did not render its visible budget");
    search.value = "private-secret"; search.dispatchEvent(new Event("input", { bubbles: true }));
    ok(matchCount.textContent === "0 of 0 matches" && ![...document.querySelectorAll(".navigator-title,.navigator-detail")].some(node => node.textContent.includes(privateNonce)), "a malformed private payload exposed nonce-bearing text");
    search.value = "overflow-secret"; search.dispatchEvent(new Event("input", { bubbles: true }));
    ok(matchCount.textContent === "0 of 0 matches", "an over-budget private payload was indexed");
    const longCodeMatch = Array.from({ length: 25 }, (_, index) => index === 24 ? "collapsed needle" : "line " + index).join("\\n");
    window.__events.emit({ status: "complete", responses: [response("collapsed-match", "~~~javascript\\n" + longCodeMatch + "\\n~~~")], latestId: "collapsed-match", revision: 34, nonce: privateNonce });
    ok(await pollUntil(() => body.querySelector("pre.code-collapsed")), "collapsed-code fixture did not render a collapsed block");
    search.value = "collapsed needle"; search.dispatchEvent(new Event("input", { bubbles: true })); nextMatch.click();
    ok(await pollUntil(() => !body.querySelector("pre")?.classList.contains("code-collapsed") && body.querySelector("mark.response-search-match")?.textContent === "collapsed needle"), "a collapsed-code match was not expanded through its normal control");
    const exactlyFiveHundred = Array.from({ length: 500 }, () => "needle").join(" ");
    window.__events.emit({ status: "complete", responses: [response("exact-cap", exactlyFiveHundred)], latestId: "exact-cap", revision: 35, nonce: privateNonce });
    ok(await pollUntil(() => body.textContent.includes("needle")), "exact-cap fixture did not render"); search.value = "needle"; search.dispatchEvent(new Event("input", { bubbles: true }));
    ok(matchCount.textContent === "0 of 500 matches", "exactly 500 matches incorrectly disclosed an extra result");
    const beyondOldFoldLimit = "a".repeat(2 * 1024 * 1024 + 128) + " searchable needle";
    window.__events.emit({ status: "complete", responses: [response("beyond-old-fold-limit", beyondOldFoldLimit)], latestId: "beyond-old-fold-limit", revision: 36, nonce: privateNonce });
    ok(await pollUntil(() => body.textContent.includes("searchable needle")), "large searchable fixture did not render"); search.value = "searchable needle"; search.dispatchEvent(new Event("input", { bubbles: true }));
    ok(matchCount.textContent === "0 of 1 matches", "a legal response beyond the old 2 MiB fold ceiling was not searchable");
    nextMatch.click(); ok(await pollUntil(() => body.querySelector("mark.response-search-match")), "large-response navigation did not create a highlight");
    const liveIndexesAfterFirstNavigation = window.ResponseViewerNavigator.largeIndexBuilds(); nextMatch.click();
    ok(window.ResponseViewerNavigator.largeIndexBuilds() === liveIndexesAfterFirstNavigation, "repeated match navigation rebuilt the selected live-body index");
    // Projection work is lazy: receipt and status-only updates leave detached rendering untouched.
    search.value = ""; search.dispatchEvent(new Event("input", { bubbles: true }));
    const buildsBeforeLazy = window.ResponseViewerNavigator.projectionBuilds(), indexesBeforeLazy = window.ResponseViewerNavigator.largeIndexBuilds(), lazyLarge = "l".repeat(1024 * 1024 + 128) + " lazy visible needle";
    window.__events.emit({ status: "complete", responses: [response("lazy", lazyLarge)], latestId: "lazy", revision: 37, nonce: privateNonce });
    ok(window.ResponseViewerNavigator.projectionBuilds() === buildsBeforeLazy && window.ResponseViewerNavigator.largeIndexBuilds() === indexesBeforeLazy, "an empty-query receipt built a detached search projection or folded index");
    window.__events.emit({ status: "running", responses: [response("lazy", lazyLarge, "running")], latestId: "lazy", revision: 38, nonce: privateNonce });
    ok(window.ResponseViewerNavigator.projectionBuilds() === buildsBeforeLazy && window.ResponseViewerNavigator.largeIndexBuilds() === indexesBeforeLazy, "a status-only update rebuilt detached search state");
    search.value = "lazy visible needle"; search.dispatchEvent(new Event("input", { bubbles: true }));
    ok(await pollUntil(() => window.ResponseViewerNavigator.projectionBuilds() > buildsBeforeLazy && window.ResponseViewerNavigator.largeIndexBuilds() > indexesBeforeLazy), "a non-empty search did not build its deferred large projection/index");
    nextMatch.click(); const indexesAfterFirstHighlight = window.ResponseViewerNavigator.largeIndexBuilds();
    ok(await pollUntil(() => body.querySelector("mark.response-search-match")), "large lazy search did not build the selected-body index");
    search.value = ""; search.dispatchEvent(new Event("input", { bubbles: true }));
    const buildsAfterRelease = window.ResponseViewerNavigator.projectionBuilds(), indexesAfterRelease = window.ResponseViewerNavigator.largeIndexBuilds();
    window.__events.emit({ status: "complete", responses: [response("lazy", lazyLarge)], latestId: "lazy", revision: 39, nonce: privateNonce });
    ok(window.ResponseViewerNavigator.projectionBuilds() === buildsAfterRelease && window.ResponseViewerNavigator.largeIndexBuilds() === indexesAfterRelease, "empty-query update retained or rebuilt released search state");
    search.value = "lazy visible needle"; search.dispatchEvent(new Event("input", { bubbles: true })); nextMatch.click();
    ok(await pollUntil(() => window.ResponseViewerNavigator.projectionBuilds() > buildsAfterRelease && window.ResponseViewerNavigator.largeIndexBuilds() > indexesAfterFirstHighlight && body.querySelector("mark.response-search-match")), "clearing search did not release large projection and selected-body indexes for lazy rebuild");
    // BR is a real visible boundary, rather than an invisible text join.
    window.__events.emit({ status: "complete", responses: [response("br-boundary", "alpha<br>beta")], latestId: "br-boundary", revision: 40, nonce: privateNonce });
    ok(await pollUntil(() => body.textContent.includes("alpha")), "BR-boundary fixture did not render"); search.value = "alphabeta"; search.dispatchEvent(new Event("input", { bubbles: true }));
    ok(matchCount.textContent === "0 of 0 matches", "search joined text across a rendered BR");
    // An in-budget Mermaid block gets the same budget treatment in the detached projection as the
    // reader: its source is hidden, and it consumes one of the 64 rich-fence slots.
    const mermaidBudget = ["~~~mermaid", "graph TD; A[mermaid needle]-->B;", "~~~", ...Array.from({ length: 64 }, (_, index) => "~~~json\\n{\\\"slot\\\":" + index + "}\\n~~~")].join("\\n\\n");
    window.__events.emit({ status: "complete", responses: [response("mermaid-budget", mermaidBudget)], latestId: "mermaid-budget", revision: 41, nonce: privateNonce });
    ok(await pollUntil(() => body.querySelector(".mermaid-host svg") && body.querySelectorAll(".json-view").length === 63), "Mermaid did not consume the same rich-fence budget as live decoration");
    search.value = "mermaid needle"; search.dispatchEvent(new Event("input", { bubbles: true }));
    ok(matchCount.textContent === "0 of 0 matches" && !window.ResponseViewerNavigator.visibleMap(body).text.includes("mermaid needle"), "an in-budget Mermaid source was indexed despite being hidden");
    // CSV header buttons are visible reader text, and ordinal fallback can restore a post-sort match.
    const csvNeedle = "needle column,value\\nfirst,2\\nsecond,1";
    window.__events.emit({ status: "complete", responses: [response("csv-heading", "~~~csv\\n" + csvNeedle + "\\n~~~")], latestId: "csv-heading", revision: 42, nonce: privateNonce });
    ok(await pollUntil(() => body.querySelector(".csv-view th button")), "CSV heading fixture did not render"); search.value = "needle column"; search.dispatchEvent(new Event("input", { bubbles: true })); nextMatch.click();
    ok(await pollUntil(() => body.querySelector(".csv-view th mark.response-search-match")), "visible CSV header button text was not searchable");
    body.querySelector(".csv-view th button").click(); nextMatch.click();
    ok(await pollUntil(() => body.querySelector(".csv-view th mark.response-search-match")), "post-sort navigation did not restore the CSV header match");
    // The global cap hides later navigator rows without a navigable match.
    const capFirst = Array.from({ length: 501 }, () => "needle").join(" ");
    window.__events.emit({ status: "complete", responses: [response("cap-first", capFirst), response("cap-later", "needle later")], latestId: "cap-later", revision: 43, nonce: privateNonce });
    ok(await pollUntil(() => body.textContent.includes("needle later")), "cap-row fixture did not render"); search.value = "needle"; search.dispatchEvent(new Event("input", { bubbles: true }));
    ok(document.querySelectorAll(".navigator-item").length === 1 && document.querySelector(".navigator-item")?.dataset.responseId === "cap-first" && matchCount.textContent === "0 of 500+ matches", "a non-navigable later response survived the global match cap");
    // Manual history selection and automatic latest following reset a stale match cursor.
    const switchA = "# A\\n\\nneedle A", switchB = "# B\\n\\nneedle B", switchC = "# C\\n\\nneedle C";
    window.__events.emit({ status: "complete", responses: [response("switch-a", switchA), response("switch-b", switchB)], latestId: "switch-b", revision: 44, nonce: privateNonce });
    ok(await pollUntil(() => body.textContent.includes("needle B")), "switch fixture did not render"); search.value = "needle"; search.dispatchEvent(new Event("input", { bubbles: true })); nextMatch.click();
    document.getElementById("next-response").click(); ok(await pollUntil(() => body.textContent.includes("needle B") && matchCount.textContent === "0 of 2 matches"), "manual response selection retained a stale match cursor");
    window.__events.emit({ status: "complete", responses: [response("switch-a", switchA), response("switch-b", switchB), response("switch-c", switchC)], latestId: "switch-c", revision: 45, nonce: privateNonce });
    ok(await pollUntil(() => body.textContent.includes("needle C") && matchCount.textContent === "0 of 3 matches"), "automatic latest following retained a stale match cursor");
    // A near-legal 4 MiB response gets one reusable folded index; range navigation does not rebuild it.
    const nearLimit = "x".repeat(4 * 1024 * 1024 - 32) + " searchable needle", nearPrepared = window.ResponseViewerNavigator.foldedText(nearLimit), indexesBeforeReuse = window.ResponseViewerNavigator.largeIndexBuilds();
    ok(window.ResponseViewerNavigator.ranges(nearPrepared, window.ResponseViewerNavigator.foldedNeedle("searchable needle"), 1).length === 1, "a near-legal 4 MiB response was not searchable");
    window.ResponseViewerNavigator.ranges(nearPrepared, window.ResponseViewerNavigator.foldedNeedle("searchable needle"), 1);
    ok(window.ResponseViewerNavigator.largeIndexBuilds() === indexesBeforeReuse, "repeated navigation rebuilt a cached large response index");
    // Cleanup removes the named controls too: a closed reader cannot rehydrate its cache or mutate DOM.
    const beforeClose = body.innerHTML; window.__events.emit({ status: "closed", responses: [], latestId: null, revision: 46, nonce: privateNonce }); previousMatch.click(); nextMatch.click();
    ok(body.innerHTML === beforeClose, "closed viewer match controls still mutated the response body");
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
