import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = join(here, "test-fixtures");
const child = join(fixtureDirectory, ".production-navigation-child.html");
const printFixture = join(fixtureDirectory, ".production-print.html");
const printPdf = join(fixtureDirectory, ".production-print-playwright.pdf");
const fallbackPdf = join(fixtureDirectory, ".production-print-fallback.pdf");
const printText = join(fixtureDirectory, ".production-print.txt");
const fallbackText = join(fixtureDirectory, ".production-print-fallback.txt");
const pdfToText = ["/opt/homebrew/bin/pdftotext", "/usr/bin/pdftotext"].find(existsSync);
const printSentinels = ["PRINT_START", "PRINT_CODE_FIRST", "PRINT_CODE_LAST", "PRINT_TABLE_FIRST", "PRINT_TABLE_LAST", "POST_BLOCK_END"];
const hiddenPrintChrome = ["Previous response", "Next response", "Switch theme", "Copy", "Wrap", "Expand", "On this page"];
const widths = [320, 768, 1280];
const wrapper = (width: number) => join(fixtureDirectory, `.production-navigation-${width}.html`);
const pass = (width: number) => `PASS: response viewer navigation ${width}px`;
const prelude = `<script>
  history.replaceState(null, "", "#%ED%98%84%EC%9E%AC-%EA%B5%AC%EC%A1%B0");
  class EventSourceMock { constructor() { this.listeners = {}; window.__events = this; } addEventListener(type, listener) { this.listeners[type] = listener; } close() { this.closed = true; } emit(snapshot) { if (!snapshot.responses) { const response = { id: "fixture", markdown: snapshot.markdown || "", status: snapshot.status === "closed" ? "complete" : snapshot.status, error: snapshot.error || null, truncated: false }; snapshot = { status: snapshot.status, responses: snapshot.status === "closed" ? [] : [response], latestId: snapshot.status === "closed" ? null : response.id, revision: snapshot.revision }; } this.listeners.state({ data: JSON.stringify(snapshot) }); } }
  window.EventSource = EventSourceMock;
  if (new URLSearchParams(location.search).has("dump-dom")) {
    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = query => query === "(prefers-reduced-motion: reduce)" ? { matches: true, addEventListener() {}, removeEventListener() {} } : nativeMatchMedia(query);
    document.documentElement.style.scrollBehavior = "auto";
    window.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 16);
    window.cancelAnimationFrame = clearTimeout;
  }
  window.__copied = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => window.__copied.push(text) } });
</script>`;
const childTest = `<script>
(async () => {
  const wait = frames => new Promise(resolve => { const next = () => frames-- ? requestAnimationFrame(next) : resolve(); next(); });
  const fail = message => { throw new Error(message); }, ok = (value, message) => { if (!value) fail(message); };
  const send = (success, message = "") => parent.postMessage({ responseViewerNavigation: true, success, message }, "*");
  try {
    const expectedWidth = Number(new URLSearchParams(location.search).get("width"));
    ok(innerWidth === expectedWidth, "iframe width " + innerWidth + " is not " + expectedWidth);
    await document.fonts.load('16px "Pretendard Variable"'); await document.fonts.ready;
    const sections = [];
    for (let i = 1; i <= 28; i++) sections.push("# 발견 " + i, "## 현재 항목 " + i, "### 세부 항목 " + i, "이 문단은 실제 문서 높이와 목차 overflow를 검증하기 위한 충분히 긴 내용입니다. " + "가나다라마바사 ".repeat(28), "~~~js", "const item" + i + " = true;", "~~~");
    const longCode = Array.from({ length: 25 }, (_, i) => "long line " + (i + 1)).join("\\n");
    const markdown = ["# 시작", "## 현재 구조", "### 세부 구조", "현재 구조의 hash target입니다.", "## 1. " + String.fromCharCode(96) + "ListReservedInfraNodesByVmClusterID" + String.fromCharCode(96) + " *영향은 제한적임*", "~~~unknown\\n</span><img onerror=alert(1)>\\n~~~", "~~~\\n" + longCode + "\\n~~~", ...sections].join("\\n\\n");
    const events = window.__events;
    const response = (id, text, state = "complete", extra = {}) => ({ id, markdown: text, status: state, error: null, truncated: false, ...extra });
    const earlier = "# Earlier response\\n\\n## Earlier outline\\n\\nThis response must remain readable.";
    const middle = ["# Middle response", "## Middle outline", ...Array.from({ length: 32 }, () => "This is a deliberately long previous response for history-top positioning. " + "middle ".repeat(24))].join("\\n\\n");
    const emit = (responses, latestId, revision, state = "running") => events.emit({ status: state, responses, latestId, revision });
    let records = [response("earlier", earlier), response("middle", middle), response("latest", markdown, "running")];
    emit(records, "latest", 1);
    await wait(6);
    const historyControl = document.getElementById("history-control"), previous = document.getElementById("previous-response"), next = document.getElementById("next-response");
    ok(!historyControl.hidden && document.getElementById("history-position").textContent === "3 / 3", "history controls do not show the latest position");
    ok(!previous.disabled && next.disabled, "history end buttons have incorrect disabled state");
    previous.click(); await wait(2);
    ok(document.getElementById("response-body").textContent.includes("Middle response"), "previous button did not render immediately");
    ok(document.getElementById("outline-links").textContent.includes("Middle outline") && !document.getElementById("outline-links").textContent.includes("현재 구조"), "outline did not regenerate for the selected response");
    ok(document.getElementById("response-meta").textContent.includes("Previous response · 2 of 3"), "previous response eyebrow is wrong");
    ok(document.title.startsWith("Previous: Middle response"), "previous response title is wrong: " + document.title);
    ok(document.querySelector("article").getAttribute("aria-label") === "Assistant response", "article accessibility label is not neutral");
    ok(!previous.disabled && !next.disabled, "previous history button state is wrong");
    next.click(); await wait(2); ok(document.getElementById("response-body").textContent.includes("현재 구조"), "next button did not restore latest response");
    history.replaceState(null, "", "#%ED%98%84%EC%9E%AC-%EA%B5%AC%EC%A1%B0"); dispatchEvent(new Event("hashchange")); await wait(3);
    const target = document.getElementById("현재-구조"), toolbar = document.querySelector(".toolbar"), outline = document.getElementById("response-outline"), list = document.getElementById("outline-links");
    const current = () => document.querySelector('#outline-links a[aria-current="true"]');
    const targetTop = target.getBoundingClientRect().top, toolbarBottom = toolbar.getBoundingClientRect().bottom, tolerance = parseFloat(getComputedStyle(target).scrollMarginTop) + 2.5;
    ok(targetTop >= toolbarBottom && targetTop <= tolerance, "hash geometry " + targetTop + " is outside " + toolbarBottom + ".." + tolerance);
    ok(!((innerHeight + scrollY) >= document.documentElement.scrollHeight - 140), "hash navigation followed document bottom");
    ok(current()?.getAttribute("href") === "#현재-구조", "hash outline item is not current after settling");
    const links = [...list.querySelectorAll("a")];
    ok(links.find(link => link.textContent === "1. ListReservedInfraNodesByVmClusterID 영향은 제한적임"), "inline code/emphasis outline label is incomplete");
    ok(links.some(link => link.dataset.level === "1") && links.some(link => link.dataset.level === "2") && links.some(link => link.dataset.level === "3"), "outline level metadata is incomplete");
    ok(document.documentElement.scrollWidth <= innerWidth, "horizontal overflow");
    ok(outline.open === (expectedWidth > 1180), "incorrect initial outline state");
    ok(list.scrollHeight > list.clientHeight || !outline.open, "outline list does not overflow on desktop");
    const permalink = document.querySelector(".heading-link"); permalink.focus(); await wait(1); ok(Number(getComputedStyle(permalink).opacity) > 0, "focused permalink remains hidden");
    const firstCode = document.querySelector(".code-block");
    ok(firstCode.querySelector(".code-language").textContent === "Plain" && !firstCode.querySelector("pre code span.token"), "unknown fence was highlighted or mislabeled");
    ok(firstCode.querySelector("pre code").textContent.includes("<img onerror"), "hostile code did not remain inert text");
    const longBlock = [...document.querySelectorAll(".code-block")].find(block => block.querySelector(".code-expand-toggle"));
    ok(longBlock && longBlock.querySelector("pre").classList.contains("code-collapsed"), "long code did not start collapsed");
    const expand = longBlock.querySelector(".code-expand-toggle"); expand.click(); ok(expand.getAttribute("aria-expanded") === "true" && !longBlock.querySelector("pre").classList.contains("code-collapsed"), "long code did not expand");
    const wrap = longBlock.querySelector(".code-wrap-toggle"); wrap.click(); ok(wrap.getAttribute("aria-pressed") === "true" && longBlock.querySelector("pre").classList.contains("code-wrapped"), "Wrap did not update state");
    previous.click(); await wait(2); next.click(); await wait(2);
    const historyRestored = [...document.querySelectorAll(".code-block")].find(block => block.querySelector(".code-expand-toggle"));
    ok(historyRestored?.querySelector("pre").classList.contains("code-wrapped") && historyRestored?.querySelector("pre").classList.contains("code-expanded") && historyRestored.querySelector(".code-expand-toggle").getAttribute("aria-expanded") === "true", "history navigation lost code preferences");
    const javascript = [...document.querySelectorAll(".code-block")].find(block => block.querySelector(".code-language").textContent === "JavaScript");
    ok(javascript?.querySelector("pre code span.token"), "explicit JavaScript fence has no Prism tokens");
    ok(!javascript.querySelector(".code-expand-toggle"), "short code unexpectedly has expand control");
    document.querySelector(".copy-code").click(); await wait(2); ok(window.__copied.some(text => text.includes("</span><img onerror=alert(1)>")), "code Copy was not exact original text");
    const pausedY = scrollY;
    records = [response("earlier", earlier), response("middle", middle), response("latest", markdown + "\\n\\n" + "streaming ".repeat(100), "running")]; emit(records, "latest", 2); await new Promise(resolve => setTimeout(resolve, 100));
    records = [response("earlier", earlier), response("middle", middle), response("latest", markdown + "\\n\\n" + "streaming ".repeat(200), "running")]; emit(records, "latest", 3); await new Promise(resolve => setTimeout(resolve, 100));
    ok([...document.querySelectorAll(".code-block")].every(block => block.querySelectorAll(".code-actions").length === 1), "streamed rerender retained duplicate code controls");
    const streamRestored = [...document.querySelectorAll(".code-block")].find(block => block.querySelector(".code-expand-toggle"));
    ok(streamRestored?.querySelector("pre").classList.contains("code-wrapped") && streamRestored?.querySelector("pre").classList.contains("code-expanded") && streamRestored.querySelector(".code-wrap-toggle").getAttribute("aria-pressed") === "true", "streamed rerender lost code preferences");
    ok(Math.abs(scrollY - pausedY) <= 6, "hash-paused stream moved document " + pausedY + " to " + scrollY);
    ok(!document.getElementById("new-content").hidden, "hash-paused stream did not expose Jump");
    document.getElementById("new-content").click();
    for (let i = 0; i < 90 && innerHeight + scrollY < document.documentElement.scrollHeight - 140; i++) await new Promise(resolve => setTimeout(resolve, 20));
    ok(innerHeight + scrollY >= document.documentElement.scrollHeight - 140, "Jump did not reach document bottom");
    const deep = document.getElementById("세부-항목-28"); deep.scrollIntoView({ block: "start", behavior: "instant" }); if (new URLSearchParams(location.search).has("dump-dom")) dispatchEvent(new Event("scroll")); await wait(5);
    ok(current()?.getAttribute("href") === "#세부-항목-28", "real scroll spy did not activate deep H3");
    if (!outline.open) { outline.open = true; await wait(4); }
    list.scrollTop = 0; const documentY = scrollY; outline.dispatchEvent(new Event("toggle")); await wait(4);
    const active = current(), listRect = list.getBoundingClientRect(), activeRect = active.getBoundingClientRect();
    ok(list.scrollTop > 0, "toggle reveal did not scroll the outline list");
    ok(activeRect.top >= listRect.top - 2 && activeRect.bottom <= listRect.bottom + 2, "active outline item is not visible in its list");
    ok(Math.abs(scrollY - documentY) < 2, "outline reveal moved document from " + documentY + " to " + scrollY);
    previous.click(); await wait(2); const responseHeader = document.querySelector(".response-header").getBoundingClientRect(), toolbarAfterHistory = document.querySelector(".toolbar").getBoundingClientRect();
    ok(responseHeader.top >= toolbarAfterHistory.bottom - 1, "history switch left response header beneath sticky toolbar");
    next.click(); await wait(2);
    document.getElementById("new-content").click(); await wait(2);
    previous.click(); await wait(2); previous.click(); await wait(2); const oldText = document.getElementById("response-body").textContent;
    records = [...records.slice(0, 2), response("latest", markdown + "\\n\\nbackground stream", "running")]; emit(records, "latest", 4); await new Promise(resolve => setTimeout(resolve, 120));
    ok(document.getElementById("response-body").textContent === oldText, "latest stream rerendered an older selection");
    emit([response("middle", middle), response("latest", markdown, "running")], "latest", 5); await wait(2);
    ok(document.getElementById("response-body").textContent.includes("Middle response"), "removed selected response did not fall back to available history");
    next.click(); await wait(2); next.click(); await wait(2);
    const parse = window.ResponseViewerRenderer.render; let parses = 0; window.ResponseViewerRenderer.render = text => { parses += 1; return parse(text); };
    const beforeBurst = parses, long = markdown + "\\n\\n" + "adaptive ".repeat(3_000);
    for (let i = 0; i < 12; i++) emit([response("middle", middle), response("latest", long + i, "running")], "latest", 6 + i);
    await new Promise(resolve => setTimeout(resolve, 500));
    ok(parses - beforeBurst < 6, "adaptive rendering parsed too many running snapshots: " + (parses - beforeBurst));
    emit([response("middle", middle), response("latest", long + " FINAL", "complete")], "latest", 18, "complete"); await wait(2);
    ok(document.getElementById("response-body").textContent.includes("FINAL"), "complete snapshot did not immediately render newest text");
    events.listeners.error(); await wait(1); ok(document.title.startsWith("Reconnecting:") && document.getElementById("response-meta").textContent.includes("Reconnecting"), "reconnect state is not visible");
    events.listeners.open(); await wait(1); ok(!document.title.startsWith("Reconnecting:") && document.getElementById("response-body").textContent.includes("FINAL"), "EventSource open did not recover content");
    emit([response("middle", middle), response("latest", "Plain fallback title\\n\\nNo heading is present.", "complete")], "latest", 19, "complete"); await wait(2);
    ok(document.title.startsWith("Response: Plain fallback title"), "Markdown fallback title is wrong: " + document.title);
    emit([response("middle", middle), response("latest", "waiting for terminal hash", "running")], "latest", 20); history.replaceState(null, "", "#missing-complete"); dispatchEvent(new Event("hashchange")); await wait(1);
    emit([response("middle", middle), response("latest", "completed without that heading", "complete")], "latest", 21, "complete"); await wait(2);
    ok(!location.hash, "unresolved hash survived terminal complete");
    emit([response("middle", middle), response("latest", "waiting for error hash", "running")], "latest", 22); history.replaceState(null, "", "#missing-error"); dispatchEvent(new Event("hashchange")); await wait(1);
    emit([response("middle", middle), response("latest", "failed without that heading", "error")], "latest", 23, "error"); await wait(2);
    ok(!location.hash, "unresolved hash survived terminal error");
    history.replaceState(null, "", "#new-outline"); dispatchEvent(new Event("hashchange")); await wait(1);
    emit([response("middle", middle), response("latest", markdown, "complete"), response("newest", "# Newest title\\n\\n## New outline", "running")], "newest", 24); await wait(2);
    ok(document.getElementById("response-body").textContent.includes("Newest title") && !location.hash, "latest append did not clear hash before switching responses");
    records = [response("middle", middle), response("latest", markdown + "\\n\\nqueued follow", "running")]; emit(records, "latest", 25); const beforeClose = scrollY;
    events.emit({ status: "closed", responses: records, latestId: "latest", revision: 26 }); await wait(4);
    ok(events.closed, "close did not close EventSource"); ok(Math.abs(scrollY - beforeClose) < 2, "queued follow moved document after close");
    send(true);
  } catch (error) { send(false, error instanceof Error ? error.message : String(error)); }
})();
</script>`;
const wrapperSource = (width: number) => `<!doctype html><meta charset="utf-8"><title>Response viewer navigation pending</title><style>html,body{margin:0;background:#fff}iframe{display:block;width:${width}px;height:900px;border:0}</style><iframe id="fixture"></iframe><pre id="result">pending</pre><script>addEventListener("message", event => { const data = event.data; if (!data || !data.responseViewerNavigation) return; document.title = data.success ? ${JSON.stringify(pass(width))} : "FAIL: " + data.message; document.getElementById("result").textContent = document.title; }); document.getElementById("fixture").src = ".production-navigation-child.html?width=${width}" + (location.search.includes("dump-dom") ? "&dump-dom=1" : "");</script>`;
const chrome = [process.env.RESPONSE_VIEWER_CHROME, process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path): path is string => typeof path === "string" && existsSync(path));
const playwrightRoots = process.env.RESPONSE_VIEWER_PLAYWRIGHT ? [process.env.RESPONSE_VIEWER_PLAYWRIGHT] : (await readdir(join(homedir(), ".npm", "_npx"), { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory()).map(entry => join(homedir(), ".npm", "_npx", entry.name, "node_modules", "playwright-core"));
const playwright = playwrightRoots.find(path => existsSync(join(path, "package.json")));
const assertPdf = async (path: string, textPath: string, label: string) => {
  assert((await stat(path)).size > 1_000, `${label} PDF is empty`);
  if (!pdfToText) { console.log(`SKIP: ${label} PDF text extraction (pdftotext unavailable; nonempty PDF retained)`); return; }
  await execFile(pdfToText, [path, textPath], { timeout: 30_000 });
  const text = await readFile(textPath, "utf8"), compactText = text.replace(/\s+/g, "");
  for (const sentinel of printSentinels) assert.equal(compactText.includes(sentinel), true, `${label} PDF lost ${sentinel}`);
  for (const chromeLabel of hiddenPrintChrome) assert.doesNotMatch(compactText, new RegExp(chromeLabel.replace(/\s/g, "")), `${label} PDF retained print-hidden UI: ${chromeLabel}`);
  console.log(`PASS: ${label} PDF text sentinels and hidden chrome`);
};
let profile: string | undefined;
try {
  const template = await readFile(join(here, "template.html"), "utf8");
  const production = template.replaceAll('url("vendor/', 'url("../vendor/').replaceAll('src="vendor/', 'src="../vendor/').replaceAll('src="link-policy.js"', 'src="../link-policy.js"').replaceAll('src="renderer.js"', 'src="../renderer.js"').replaceAll('src="syntax.js"', 'src="../syntax.js"').replaceAll('src="client.js"', 'src="../client.js"').replace('  <script src="../vendor/marked-18.0.5.umd.js">', `${prelude}\n  <script src="../vendor/marked-18.0.5.umd.js">`).replace("</body>", `${childTest}</body>`);
  await writeFile(child, production);
  const printMarkdown = ["# PRINT_START", "~~~text", "PRINT_CODE_FIRST", ...Array.from({ length: 360 }, (_, index) => `print code line ${index + 1} ${"x".repeat(76)}`), "PRINT_CODE_LAST", "~~~", "| Key | Value |", "| --- | --- |", "| PRINT_TABLE_FIRST | first row |", ...Array.from({ length: 180 }, (_, index) => `| row ${index + 1} | ${"print table content ".repeat(8)} |`), "| PRINT_TABLE_LAST | last row |", "## POST_BLOCK_END"].join("\n");
  const printSnapshot = JSON.stringify({ status: "complete", responses: [{ id: "print", markdown: printMarkdown, status: "complete", error: null, truncated: false }], latestId: "print", revision: 1 });
  const printProduction = template.replaceAll('url("vendor/', 'url("../vendor/').replaceAll('src="vendor/', 'src="../vendor/').replaceAll('src="link-policy.js"', 'src="../link-policy.js"').replaceAll('src="renderer.js"', 'src="../renderer.js"').replaceAll('src="syntax.js"', 'src="../syntax.js"').replaceAll('src="client.js"', 'src="../client.js"').replace('  <script src="../vendor/marked-18.0.5.umd.js">', `${prelude}\n  <script src="../vendor/marked-18.0.5.umd.js">`).replace("</body>", `<script>window.__events.emit(${printSnapshot});window.__printReady=true;</script></body>`);
  await writeFile(printFixture, printProduction);
  for (const width of widths) await writeFile(wrapper(width), wrapperSource(width));
  if (!chrome) console.log("SKIP: response-viewer browser suite (Chrome/Chromium missing)");
  else {
    const playwrightModule = playwright ? await import(pathToFileURL(join(playwright, "index.js")).href).then(module => module.default, () => undefined) : undefined;
    if (playwrightModule?.chromium) {
      const browser = await playwrightModule.chromium.launch({ headless: true, executablePath: chrome, args: ["--allow-file-access-from-files", "--disable-background-networking", "--disable-component-update"] });
      try {
        const run = async (path: string, title: string) => {
          const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
          try {
            await page.goto(pathToFileURL(path).href, { waitUntil: "load", timeout: 15_000 });
            await page.waitForFunction(`document.title === ${JSON.stringify(title)} || document.title.startsWith("FAIL: ")`, { timeout: 30_000 });
            assert.equal(await page.title(), title, await page.locator("#result").textContent() || "browser fixture did not pass");
            console.log(`PASS: ${title}`);
          } finally { await page.close(); }
        };
        await run(join(fixtureDirectory, "renderer-security.html"), "PASS: response viewer renderer security");
        for (const width of widths) await run(wrapper(width), pass(width));
        const printPage = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
        try {
          await printPage.goto(pathToFileURL(printFixture).href, { waitUntil: "load", timeout: 15_000 });
          await printPage.waitForFunction("window.__printReady && document.body.textContent.includes('POST_BLOCK_END')", { timeout: 30_000 });
          assert.equal(await printPage.locator("table").count(), 1, "print fixture did not render its table");
          await printPage.emulateMedia({ media: "print" });
          const printState = await printPage.evaluate(`(() => ({ toolbar: getComputedStyle(document.querySelector(".toolbar")).display, outline: getComputedStyle(document.querySelector(".outline")).display, controls: getComputedStyle(document.querySelector(".code-actions")).display, permalink: getComputedStyle(document.querySelector(".heading-link")).display, preMaxHeight: getComputedStyle(document.querySelector("pre")).maxHeight, preOverflow: getComputedStyle(document.querySelector("pre")).overflow, tableOverflow: getComputedStyle(document.querySelector(".table-wrap")).overflow, codeBreakInside: getComputedStyle(document.querySelector(".code-block")).breakInside, articleWidth: getComputedStyle(document.querySelector(".article-body")).width, background: getComputedStyle(document.body).backgroundColor }))()`);
          assert.equal(printState.toolbar, "none"); assert.equal(printState.outline, "none"); assert.equal(printState.controls, "none"); assert.equal(printState.permalink, "none"); assert.equal(printState.preMaxHeight, "none"); assert.equal(printState.preOverflow, "visible"); assert.equal(printState.tableOverflow, "visible"); assert.equal(printState.codeBreakInside, "auto"); assert.notEqual(printState.articleWidth, "0px"); assert.equal(printState.background, "rgb(255, 255, 255)");
          await printPage.pdf({ path: printPdf, printBackground: true });
          await assertPdf(printPdf, printText, "Playwright");
          console.log("PASS: response viewer print media and PDF");
        } finally { await printPage.close(); }
      } finally { await browser.close(); }
    } else {
      profile = await mkdtemp(join(tmpdir(), "response-viewer-chrome-"));
      const run = async (path: string, title: string) => {
        const { stdout } = await execFile(chrome, ["--headless=new", "--dump-dom", "--run-all-compositor-stages-before-draw", "--window-size=1600,1200", "--virtual-time-budget=15000", "--allow-file-access-from-files", `--user-data-dir=${profile}`, "--disable-background-networking", "--disable-component-update", "--use-mock-keychain", "--password-store=basic", `${pathToFileURL(path).href}?dump-dom=1`], { timeout: 45_000, maxBuffer: 10 * 1024 * 1024 });
        const actualTitle = stdout.match(/<title>([\s\S]*?)<\/title>/i)?.[1];
        const result = stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/i)?.[1];
        assert.equal(actualTitle, title, `Chrome fixture did not pass: ${actualTitle ?? "missing title"}`);
        assert.equal(result, title, `Chrome fixture result did not pass: ${result ?? "missing PASS marker"}`);
        console.log(`PASS: ${title}`);
      };
      await run(join(fixtureDirectory, "renderer-security.html"), "PASS: response viewer renderer security");
      for (const width of widths) await run(wrapper(width), pass(width));
      await execFile(chrome, ["--headless=new", `--print-to-pdf=${fallbackPdf}`, "--no-pdf-header-footer", "--virtual-time-budget=15000", "--allow-file-access-from-files", `--user-data-dir=${profile}`, "--disable-background-networking", "--disable-component-update", "--use-mock-keychain", "--password-store=basic", pathToFileURL(printFixture).href], { timeout: 45_000, maxBuffer: 10 * 1024 * 1024 });
      await assertPdf(fallbackPdf, fallbackText, "Chrome fallback");
    }
  }
} finally {
  if (profile) await rm(profile, { recursive: true, force: true });
  await Promise.all([rm(child, { force: true }), rm(printFixture, { force: true }), rm(printPdf, { force: true }), rm(fallbackPdf, { force: true }), rm(printText, { force: true }), rm(fallbackText, { force: true }), ...widths.map(width => rm(wrapper(width), { force: true }))]);
}
