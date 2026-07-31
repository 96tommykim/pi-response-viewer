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
  try {
    const response = (id, markdown, status = "complete") => ({ id, markdown, status, error: null, truncated: false });
    const longCode = Array.from({ length: 25 }, (_, index) => "line " + index).join("\\n");
    const latest = ["# Latest", "<img src=x onerror=alert(1)>", "~~~javascript", "const answer = 42;", "~~~", "~~~unknown", "<img src=x onerror=alert(1)>", "~~~", "~~~text", longCode, "~~~"].join("\\n\\n");
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
