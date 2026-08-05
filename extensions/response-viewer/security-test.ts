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
window.__copied = [];
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => window.__copied.push(text) } });
</script>`;
		const smoke = `<script>
(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const ok = (value, message) => { if (!value) throw new Error(message); };
  const pollUntil = async (predicate, timeout = 4000, interval = 50) => { const start = performance.now(); while (performance.now() - start < timeout) { if (predicate()) return true; await wait(interval); } return predicate(); };
  try {
    const response = (id, markdown, status = "complete") => ({ id, markdown, status, error: null, truncated: false });
    const longCode = Array.from({ length: 25 }, (_, index) => "line " + index).join("\\n");
    const validMermaid = "graph TD; A-->B;";
    const hostileMermaid = ["graph TD", "A[\\"<img src=x onerror=window.__pwned=1>\\"]-->B", "click A \\"javascript:window.__pwned=1\\"", "click B \\"https://evil.example\\""].join("\\n");
    const brokenMermaid = "graph TD; A-->";
    const validTree = ["project/", "├── src/", "│   ├── index.js", "│   └── <script>window.__pwned2=1<\\/script>", "└── README.md"].join("\\n");
    const malformedTree = ["root/", "│   ├── deep.js"].join("\\n");
    const latest = ["# Latest", "<img src=x onerror=alert(1)>", "~~~javascript", "const answer = 42;", "~~~", "~~~unknown", "<img src=x onerror=alert(1)>", "~~~", "~~~text", longCode, "~~~", "~~~mermaid", validMermaid, "~~~", "~~~mermaid", hostileMermaid, "~~~", "~~~mermaid", brokenMermaid, "~~~", "~~~tree", validTree, "~~~", "~~~tree", malformedTree, "~~~"].join("\\n\\n");
    window.__events.emit({ status: "complete", responses: [response("older", "# Older"), response("latest", latest)], latestId: "latest", revision: 1 });
    await wait(100);
    const body = document.getElementById("response-body");
    ok(!body.querySelector("img,[onerror]"), "hostile Markdown became active DOM");
    const blocks = [...body.querySelectorAll(".code-block")];
    const javascript = blocks.find(block => block.querySelector(".code-language").textContent === "JavaScript");
    const unknown = blocks.find(block => block.querySelector(".code-language").textContent === "Plain");
    const long = blocks.find(block => block.querySelector(".code-expand-toggle"));
    ok(javascript?.querySelector("span.token"), "explicit JavaScript was not highlighted");
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
    ok(!hostileSvg.querySelector("foreignObject"), "hostile mermaid svg contains a foreignObject");
    ok(!hostileSvg.innerHTML.includes("onerror"), "hostile mermaid svg retained an onerror attribute");
    ok(window.__pwned === undefined, "hostile mermaid label or click directive executed script");
    const anchorHref = anchor => anchor.getAttribute("href") ?? anchor.getAttribute("xlink:href") ?? "";
    ok(![...hostileSvg.querySelectorAll("a")].some(anchor => anchorHref(anchor).toLowerCase().startsWith("javascript:")), "javascript: click link survived the link policy");
    const externalAnchor = [...hostileSvg.querySelectorAll("a")].find(anchor => anchorHref(anchor).includes("evil.example"));
    ok(externalAnchor, "external https click link was not rendered");
    ok(externalAnchor.getAttribute("rel") === "noreferrer noopener" && externalAnchor.getAttribute("target") === "_blank", "external mermaid link missing rel/target protection");
    await wait(300);
    ok(!brokenMermaidBlock.querySelector(".mermaid-host svg"), "broken mermaid unexpectedly rendered an svg");
    ok(!brokenMermaidBlock.querySelector("pre").hidden, "broken mermaid stopped being a visible code block");
    const treeBlocks = blocks.filter(block => block.querySelector(".code-language").textContent === "Tree");
    ok(treeBlocks.length === 2, "expected two tree-labeled code blocks");
    const renderedTreeBlock = treeBlocks.find(block => block.querySelector(".tree-view"));
    const malformedTreeBlock = treeBlocks.find(block => block.querySelector("pre"));
    ok(renderedTreeBlock, "well-formed tree block did not render as a tree view");
    ok(malformedTreeBlock?.querySelector(".code-wrap-toggle"), "malformed tree did not fall back to the normal code-block path");
    ok(renderedTreeBlock.querySelectorAll("details").length === 2, "tree view did not render the expected directory count");
    const treeNames = [...renderedTreeBlock.querySelectorAll(".tree-name")].map(node => node.textContent);
    ok(treeNames.includes("README.md"), "tree view did not render README.md");
    ok(treeNames.some(treeName => treeName.includes("<script>window.__pwned2=1<\\/script>")), "hostile tree name was not rendered as literal text");
    ok(!renderedTreeBlock.querySelector("script"), "hostile tree name became an active script element");
    ok(window.__pwned2 === undefined, "hostile tree name executed script");
    javascript.querySelector(".copy-code").click(); await wait(20);
    ok(window.__copied.some(text => text.includes("const answer = 42;")), "code copy changed text");
    document.getElementById("previous-response").click(); await wait(40);
    ok(body.textContent.includes("Older") && document.getElementById("history-position").textContent === "1 / 2", "history previous did not render");
    document.getElementById("next-response").click(); await wait(40);
    ok(body.textContent.includes("Latest"), "history next did not restore latest");
    const print = [...document.styleSheets[0].cssRules].find(rule => rule instanceof CSSMediaRule && rule.conditionText === "print");
    const printCss = [...print.cssRules].map(rule => rule.cssText).join(" ");
    ok(/\.toolbar[^}]*display: none/.test(printCss) && /\.code-actions[^}]*display: none/.test(printCss) && /pre[^}]*max-height: none/.test(printCss), "print CSS does not hide controls and expand code");
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
			.replaceAll('src="client.js"', `src="${asset("client.js")}"`)
			.replace('  <script src="' + asset("vendor/marked-18.0.5.umd.js") + '">', `${prelude}\n  <script src="${asset("vendor/marked-18.0.5.umd.js")}">`)
			.replace("</body>", `${smoke}</body>`);
		await writeFile(file, source);
		const { stdout } = await execFile(chrome, ["--headless=new", "--dump-dom", "--run-all-compositor-stages-before-draw", "--virtual-time-budget=10000", "--allow-file-access-from-files", "--disable-background-networking", "--disable-component-update", "--use-mock-keychain", "--password-store=basic", pathToFileURL(file).href], { timeout: 30_000, maxBuffer: 5 * 1024 * 1024 });
		const title = stdout.match(/<title>([\s\S]*?)<\/title>/i)?.[1];
		assert.equal(title, "PASS: response viewer browser smoke", `browser smoke failed: ${title ?? "missing title"}`);
		console.log(title);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
