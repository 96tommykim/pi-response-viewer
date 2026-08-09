/* Local searchable retained-response navigator. It receives only ViewerSnapshot responses. */
(() => {
  const VIEWER_OPENER = /^\s*```(?:pi-tool|pi-think)\s*$/;
  const MAX_MATCHES = 500, MAX_FOLD_SOURCE = 4 * 1024 * 1024, MAX_SPECIAL_FENCES = 64, MAX_TOOL_FENCES = 256;
  const BLOCKS = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL"]);
  let projectionBuilds = 0, largeIndexBuilds = 0;
  const firstProse = value => { const lines = String(value || "").split(/\r?\n/); for (let index = 0; index < lines.length; index += 1) { if (VIEWER_OPENER.test(lines[index])) { index += 2; continue; } if (lines[index].trim() && !/^\s*```/.test(lines[index])) return lines[index]; } return ""; };
  const concise = value => (firstProse(value) || "Response viewer").replace(/<[^>]*>/g, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^[\s>#*`~\-\d.)]+/, "").replace(/[\*_`~]/g, "").trim().replace(/\s+/g, " ").slice(0, 96) || "Response viewer";
  const clusterAt = (source, start) => {
    let end = start + (source.codePointAt(start) > 0xffff ? 2 : 1);
    while (end < source.length) { const character = String.fromCodePoint(source.codePointAt(end)); if (!/^\p{M}$/u.test(character)) break; end += character.length; }
    return { end, value: source.slice(start, end).normalize("NFD").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/\u03c2/g, "\u03c3") };
  };
  // Grow compact offset tables while folding once. Chunks avoid an array entry per source character.
  const foldedText = value => {
    const source = String(value || "");
    if (source.length > MAX_FOLD_SOURCE) return null;
    if (source.length >= 1024) largeIndexBuilds += 1;
    const chunks = []; let chunk = "", capacity = Math.max(1024, source.length), starts = new Uint32Array(capacity), ends = new Uint32Array(capacity), length = 0;
    const grow = required => { if (required <= capacity) return; let next = capacity; while (next < required) next *= 2; const nextStarts = new Uint32Array(next), nextEnds = new Uint32Array(next); nextStarts.set(starts); nextEnds.set(ends); starts = nextStarts; ends = nextEnds; capacity = next; };
    for (let offset = 0; offset < source.length;) {
      // ASCII dominates code and tool output. Process a run without Unicode normalization or a
      // per-character temporary string; non-ASCII clusters retain the precise Unicode mapping below.
      if (source.charCodeAt(offset) <= 0x7f) {
        const start = offset; while (offset < source.length && source.charCodeAt(offset) <= 0x7f) offset += 1;
        const value = source.slice(start, offset).toLowerCase(); grow(length + value.length);
        for (let index = 0; index < value.length; index += 1) { starts[length + index] = start + index; ends[length + index] = start + index + 1; }
        chunk += value; if (chunk.length >= 8192) { chunks.push(chunk); chunk = ""; } length += value.length; continue;
      }
      const cluster = clusterAt(source, offset); grow(length + cluster.value.length);
      for (let index = 0; index < cluster.value.length; index += 1) { starts[length + index] = offset; ends[length + index] = cluster.end; }
      chunk += cluster.value; if (chunk.length >= 8192) { chunks.push(chunk); chunk = ""; }
      length += cluster.value.length; offset = cluster.end;
    }
    if (chunk) chunks.push(chunk);
    return { source, folded: chunks.join(""), starts: starts.subarray(0, length), ends: ends.subarray(0, length) };
  };
  const foldedNeedle = value => foldedText(value)?.folded || "";
  const ranges = (prepared, needle, limit = MAX_MATCHES + 1) => {
    const found = [];
    if (!prepared || !needle || limit <= 0) return found;
    for (let index = prepared.folded.indexOf(needle); index >= 0 && found.length < limit; index = prepared.folded.indexOf(needle, index + 1)) {
      const end = index + needle.length - 1; found.push({ start: prepared.starts[index], end: prepared.ends[end] });
    }
    return found;
  };
  const excluded = element => !element || element.closest(".response-prompt,.heading-link,.code-label,.code-actions,.tool-step-glyph,.mermaid-host,[hidden],script,style,.tool-step-result > summary,.thinking-view > summary") || element.matches?.("pre") && element.closest(".code-block")?.querySelector(".mermaid-host");
  // Produces reader-visible text and DOM segments. BR and block boundaries prevent false joins.
  const visibleMap = root => {
    const parts = [], segments = []; let length = 0, lastBreak = true;
    const breakHere = () => { if (!lastBreak) { parts.push("\n"); length += 1; lastBreak = true; } };
    const visit = node => {
      if (node.nodeType === Node.TEXT_NODE) { const parent = node.parentElement; if (!node.data || excluded(parent)) return; parts.push(node.data); segments.push({ node, start: length, end: length + node.data.length }); length += node.data.length; lastBreak = false; return; }
      if (node.nodeType !== Node.ELEMENT_NODE || excluded(node)) return;
      const boundary = BLOCKS.has(node.tagName) || node.tagName === "BR"; if (boundary) breakHere();
      if (node.tagName !== "BR") for (const child of node.childNodes) visit(child);
      if (boundary) breakHere();
    };
    for (const child of root.childNodes) visit(child);
    return { text: parts.join(""), segments };
  };
  const matchingNonce = source => { const nonce = window.ResponseViewerNonce; return typeof nonce === "string" && nonce && source.includes(nonce); };
  // This mirrors decorate()'s fence budgets. Mermaid is omitted only while its live code block has a host.
  const projectedRoot = markdown => {
    projectionBuilds += 1;
    const root = document.createElement("div"); root.innerHTML = window.ResponseViewerRenderer.render(markdown);
    let specialFenceCount = 0, toolFenceCount = 0;
    for (const pre of [...root.querySelectorAll("pre")]) {
      const code = pre.querySelector("code"), source = code?.textContent || "", language = code && window.ResponseViewerSyntax.languageFromCode(code), kind = language?.[0], isContext = kind === "pi-tool" || kind === "pi-think", budgetLeft = isContext ? toolFenceCount < MAX_TOOL_FENCES : specialFenceCount < MAX_SPECIAL_FENCES;
      if (kind === "mermaid" && budgetLeft) { specialFenceCount += 1; pre.remove(); continue; }
      const special = budgetLeft && language && window.ResponseViewerFences.render(kind, { source, pre });
      if (special && isContext) toolFenceCount += 1; else if (special) specialFenceCount += 1;
      if (special) pre.replaceWith(...special.nodes.filter(node => node !== pre));
      else if (isContext && matchingNonce(source)) { const hidden = document.createElement("div"); hidden.className = "context-hidden"; hidden.textContent = kind === "pi-tool" ? "Tool step hidden (viewer limit reached)" : "Thinking hidden (viewer limit reached)"; pre.replaceWith(hidden); }
    }
    return root;
  };
  const projectionFor = item => {
    if (item.text !== undefined) return item;
    const map = visibleMap(projectedRoot(item.markdown)); item.text = map.text; item.prepared = undefined; return item;
  };
  const summary = response => {
    const markdown = String(response.markdown || ""), heading = /^\s{0,3}#{1,6}\s+(.+)$/m.exec(markdown)?.[1];
    // Keep the empty-query preview cheap and stable. firstProse skips viewer-fence payload lines,
    // so this never needs detached rendering or reveals the per-session nonce.
    return { id: response.id, title: concise(response.prompt?.text || heading || "Response viewer"), snippet: concise(markdown), markdown, text: undefined, prepared: undefined, status: response.status, truncated: response.truncated, nonce: window.ResponseViewerNonce };
  };
  const contextFor = (item, needle) => { projectionFor(item); const found = ranges(item.prepared, needle, 1)[0]; if (!found) return item.snippet; return item.text.slice(Math.max(0, found.start - 56), Math.min(item.text.length, found.end + 72)).replace(/\s+/g, " ").trim().slice(0, 180) || item.snippet; };
  const highlight = (node, text, needle) => { const found = ranges(foldedText(text), needle, 1)[0]; if (!found) { node.textContent = text; return; } node.append(document.createTextNode(text.slice(0, found.start))); const mark = document.createElement("mark"); mark.textContent = text.slice(found.start, found.end); node.append(mark, document.createTextNode(text.slice(found.end))); };
  const create = ({ root, input, count, select }) => {
    const cache = new Map(); let snapshot, selectedId, destroyed = false, cachedQuery = "", cachedMatches;
    const updateCache = () => {
      if (destroyed) return []; const responses = Array.isArray(snapshot?.responses) ? snapshot.responses : [];
      for (const response of responses) { const existing = cache.get(response.id); if (!existing || existing.markdown !== response.markdown || existing.nonce !== window.ResponseViewerNonce) { cache.set(response.id, summary(response)); cachedMatches = undefined; } else { existing.status = response.status; existing.truncated = response.truncated; } }
      const ids = new Set(responses.map(response => response.id)); for (const id of cache.keys()) if (!ids.has(id)) { cache.delete(id); cachedMatches = undefined; }
      return responses;
    };
    const matches = () => {
      if (destroyed) return { matches: [], capped: false }; const query = input.value.trim(); updateCache(); if (cachedMatches && cachedQuery === query) return cachedMatches;
      const needle = foldedNeedle(query), result = []; if (!needle) { cachedQuery = query; return cachedMatches = { matches: result, capped: false }; }
      for (const response of Array.isArray(snapshot?.responses) ? snapshot.responses : []) {
        const item = projectionFor(cache.get(response.id)); if (!item.prepared) item.prepared = foldedText(item.text);
        const room = MAX_MATCHES - result.length, found = ranges(item.prepared, needle, room + 1);
        for (const [occurrence, range] of found.slice(0, room).entries()) result.push({ responseId: item.id, occurrence, ...range });
        if (found.length > room) { cachedQuery = query; return cachedMatches = { matches: result, capped: true }; }
      }
      cachedQuery = query; return cachedMatches = { matches: result, capped: false };
    };
    const render = () => {
      if (destroyed) return; const focusedId = document.activeElement?.closest?.(".navigator-item")?.dataset.responseId, responses = updateCache(), query = input.value.trim(), needle = foldedNeedle(query), data = query ? matches() : { matches: [], capped: false }, ids = new Set(data.matches.map(match => match.responseId));
      const results = query ? responses.map(response => cache.get(response.id)).filter(item => item && ids.has(item.id)) : responses.map(response => cache.get(response.id)).filter(Boolean);
      root.replaceChildren(); let focused;
      results.forEach(item => { if (query) projectionFor(item); const button = document.createElement("button"), title = document.createElement("span"), detail = document.createElement("span"), text = query ? contextFor(item, needle) : item.snippet; button.type = "button"; button.className = "navigator-item"; button.setAttribute("aria-current", String(item.id === selectedId)); button.dataset.responseId = item.id; title.className = "navigator-title"; title.textContent = item.title; detail.className = "navigator-detail"; detail.append(document.createTextNode(`${item.status}${item.truncated ? " · truncated" : ""} · `)); if (query) highlight(detail, text, needle); else detail.append(document.createTextNode(text)); button.append(title, detail); button.addEventListener("click", () => select(item.id, data.matches.find(match => match.responseId === item.id))); root.append(button); if (item.id === focusedId) focused = button; });
      count.textContent = query ? `${results.length} of ${responses.length} responses` : `${responses.length} responses`; focused?.focus();
    };
    const releaseSearchState = () => {
      cachedMatches = undefined; cachedQuery = "";
      for (const item of cache.values()) { item.text = undefined; item.prepared = undefined; }
    };
    const onInput = () => { if (!input.value.trim()) releaseSearchState(); else cachedMatches = undefined; render(); };
    input.addEventListener("input", onInput);
    return { update(next, id) { if (destroyed) return; snapshot = next; selectedId = id; cachedMatches = undefined; render(); }, matches, focus() { if (destroyed) return; const panel = input.closest("details"); if (panel) panel.open = true; input.focus(); input.select(); }, destroy() { if (destroyed) return; destroyed = true; cache.clear(); cachedMatches = undefined; input.removeEventListener("input", onInput); root.replaceChildren(); } };
  };
  window.ResponseViewerNavigator = { create, concise, foldedText, foldedNeedle, ranges, visibleMap, MAX_MATCHES, projectionBuilds: () => projectionBuilds, largeIndexBuilds: () => largeIndexBuilds };
})();
