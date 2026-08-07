/* Local searchable retained-response navigator. It receives only ViewerSnapshot responses. */
(() => {
  const concise = value => (String(value || "").split(/\r?\n/).find(line => line.trim() && !/^\s*```/.test(line)) || "Response viewer").replace(/<[^>]*>/g, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^[\s>#*`~\-\d.)]+/, "").replace(/[\*_`~]/g, "").trim().replace(/\s+/g, " ").slice(0, 96) || "Response viewer";
  const summary = response => {
    const markdown = String(response.markdown || ""), heading = /^\s{0,3}#{1,6}\s+(.+)$/m.exec(markdown)?.[1];
    return { id: response.id, title: concise(response.prompt?.text || heading || markdown), snippet: concise(markdown), markdown, folded: undefined, status: response.status, truncated: response.truncated };
  };
  const MAX_FOLD_SOURCE = 2 * 1024 * 1024;
  const clusterAt = (source, start) => {
    let end = start + (source.codePointAt(start) > 0xffff ? 2 : 1);
    while (end < source.length) {
      const character = String.fromCodePoint(source.codePointAt(end));
      if (!/^\p{M}$/u.test(character)) break;
      end += character.length;
    }
    return { end, value: source.slice(start, end).normalize("NFD").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/\u03c2/g, "\u03c3") };
  };
  // Fold only while searching. İ becomes i after mark removal, and final sigma
  // normalizes to sigma so the matching representation stays compact and stable.
  const fold = value => {
    const source = String(value || "");
    if (source.length > MAX_FOLD_SOURCE) return null;
    let folded = "";
    for (let start = 0; start < source.length;) {
      const cluster = clusterAt(source, start); folded += cluster.value; start = cluster.end;
    }
    return folded;
  };
  // Translate a folded-string match only after it is found. This bounded linear
  // scan avoids retaining a per-code-unit offset table for the response history.
  const originalRange = (source, startAt, endAt) => {
    let foldedAt = 0, start, end;
    for (let offset = 0; offset < source.length;) {
      const cluster = clusterAt(source, offset), next = foldedAt + cluster.value.length;
      if (start === undefined && startAt >= foldedAt && startAt < next) start = offset;
      if (endAt > foldedAt && endAt <= next) { end = cluster.end; break; }
      foldedAt = next; offset = cluster.end;
    }
    return start === undefined || end === undefined ? null : { start, end };
  };
  const match = (source, folded, needle) => {
    if (!folded || !needle) return null;
    const index = folded.indexOf(needle);
    return index < 0 ? null : originalRange(source, index, index + needle.length);
  };
  const contextFor = (item, needle) => {
    const found = match(item.markdown, item.folded, needle);
    if (!found) return item.snippet;
    const raw = item.markdown.slice(Math.max(0, found.start - 56), Math.min(item.markdown.length, found.end + 72));
    return raw.replace(/<[^>]*>/g, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[\*_`~]/g, "").replace(/\s+/g, " ").trim().slice(0, 180) || item.snippet;
  };
  const highlight = (node, text, needle) => {
    const found = match(text, fold(text), needle);
    if (!found) { node.textContent = text; return; }
    node.append(document.createTextNode(text.slice(0, found.start)));
    const mark = document.createElement("mark"); mark.textContent = text.slice(found.start, found.end); node.append(mark, document.createTextNode(text.slice(found.end)));
  };
  const create = ({ root, input, count, select }) => {
    const cache = new Map(); let snapshot, selectedId, destroyed = false;
    const render = () => {
      if (destroyed) return;
      const focusedId = document.activeElement?.closest?.(".navigator-item")?.dataset.responseId;
      const responses = Array.isArray(snapshot?.responses) ? snapshot.responses : [], query = input.value.trim(), needle = query ? fold(query) : null;
      for (const response of responses) {
        const existing = cache.get(response.id);
        if (!existing || existing.markdown !== response.markdown || existing.status !== response.status || existing.truncated !== response.truncated) cache.set(response.id, summary(response));
      }
      const ids = new Set(responses.map(response => response.id)); for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
      if (needle) {
        for (const item of cache.values()) if (item.folded === undefined) item.folded = fold(item.markdown);
      } else {
        for (const item of cache.values()) item.folded = undefined;
      }
      const results = responses.map(response => cache.get(response.id)).filter(item => item && (!needle || match(item.markdown, item.folded, needle)));
      root.replaceChildren();
      let focused;
      results.forEach(item => {
        const button = document.createElement("button"), title = document.createElement("span"), detail = document.createElement("span"), text = contextFor(item, needle);
        button.type = "button"; button.className = "navigator-item"; button.setAttribute("aria-current", String(item.id === selectedId)); button.dataset.responseId = item.id;
        title.className = "navigator-title"; title.textContent = item.title;
        detail.className = "navigator-detail"; detail.append(document.createTextNode(`${item.status}${item.truncated ? " · truncated" : ""} · `)); highlight(detail, text, needle);
        button.append(title, detail); button.addEventListener("click", () => select(item.id)); root.append(button);
        if (item.id === focusedId) focused = button;
      });
      count.textContent = query ? `${results.length} of ${responses.length} responses` : `${responses.length} responses`;
      focused?.focus();
    };
    const onInput = () => render(); input.addEventListener("input", onInput);
    return { update(next, id) { snapshot = next; selectedId = id; render(); }, focus() { const panel = input.closest("details"); if (panel) panel.open = true; input.focus(); input.select(); }, destroy() { destroyed = true; cache.clear(); input.removeEventListener("input", onInput); root.replaceChildren(); } };
  };
  window.ResponseViewerNavigator = { create, concise };
})();
