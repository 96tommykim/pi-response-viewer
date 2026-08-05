/* First-party file-tree text parser + DOM builder. Zero dependencies. Names only ever set via textContent. */
(() => {
  const lineRegex = /^([\s│|]*)((?:[├└+`]──?─?\s*)?)(.*)$/u;
  const cellPattern = /^(?:│\s*|\|\s*|\s+)$/u;
  const icons = {
    folder: '<path d="M1.75 4.25h4.5l1 1.5h6.5v8h-12z"/>',
    file: '<path d="M4 1.75h5.5l2.5 2.5v10h-8z"/><path d="M9.5 1.75v2.5h2.5"/>',
  };
  const icon = kind => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "tree-icon");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke-width", "1.3");
    svg.innerHTML = icons[kind];
    return svg;
  };
  const buildNode = node => {
    const li = document.createElement("li"), isDir = node.name.endsWith("/") || node.children.length > 0, nameSpan = document.createElement("span");
    nameSpan.className = "tree-name";
    nameSpan.textContent = node.name;
    if (!isDir) { li.append(icon("file"), nameSpan); return li; }
    const details = document.createElement("details"), summary = document.createElement("summary"), childList = document.createElement("ul");
    details.open = true;
    summary.append(icon("folder"), nameSpan);
    node.children.forEach(child => childList.append(buildNode(child)));
    details.append(summary, childList);
    li.append(details);
    return li;
  };
  // Parses each line independently: prefix (bars/spaces), optional connector, then the name.
  const parseLine = line => {
    const match = lineRegex.exec(line);
    const [, prefix, connector, rest] = match;
    const name = rest.replace(/\s+$/, "");
    if (!name) return null;
    if (!connector) return prefix.length === 0 ? { depth: 0, name } : null;
    if (prefix.length === 0) return { depth: 1, name };
    const cellSize = prefix.length % 4 === 0 ? 4 : prefix.length % 3 === 0 ? 3 : 0;
    if (!cellSize) return null;
    const cells = prefix.length / cellSize;
    for (let i = 0; i < cells; i++) if (!cellPattern.test(prefix.slice(i * cellSize, (i + 1) * cellSize))) return null;
    return { depth: cells + 1, name };
  };
  const build = text => {
    if (typeof text !== "string") return null;
    const lines = text.split(/\r?\n/);
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    if (!lines.length || lines.length > 2000) return null;
    const parsed = [];
    for (const line of lines) { const entry = parseLine(line); if (!entry) return null; parsed.push(entry); }
    const minDepth = Math.min(...parsed.map(entry => entry.depth));
    for (const entry of parsed) entry.depth -= minDepth;
    const roots = [], stack = [];
    for (const { depth, name } of parsed) {
      if (depth > stack.length) return null;
      stack.length = depth;
      const node = { name, children: [] };
      if (depth === 0) roots.push(node); else stack[depth - 1].children.push(node);
      stack[depth] = node;
    }
    const fragment = document.createDocumentFragment(), rootList = document.createElement("ul");
    rootList.className = "tree-root";
    roots.forEach(node => rootList.append(buildNode(node)));
    fragment.append(rootList);
    return fragment;
  };
  window.ResponseViewerTree = { build };
  window.ResponseViewerFences.register("tree", context => {
    const tree = build(context.source); if (!tree) return null;
    const view = document.createElement("div"); view.className = "tree-view"; view.append(tree);
    return { nodes: [view] };
  });
})();
