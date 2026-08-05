/* Bounded, native-details JSON viewer. */
(() => {
  const MAX_SOURCE = 256 * 1024, MAX_NODES = 4000, MAX_DEPTH = 32, MAX_KEYS = 1000;
  const valid = value => {
    const stack = [[value, 0]]; let nodes = 0;
    while (stack.length) {
      const [item, depth] = stack.pop();
      if (++nodes > MAX_NODES || depth > MAX_DEPTH) return false;
      if (item && typeof item === "object") {
        const entries = Array.isArray(item) ? item.map((value, index) => [String(index), value]) : Object.entries(item);
        if (entries.length > MAX_KEYS) return false;
        for (const [, child] of entries) stack.push([child, depth + 1]);
      }
    }
    return true;
  };
  const scalar = value => { const node = document.createElement("span"); node.className = `json-scalar json-${value === null ? "null" : typeof value}`; node.textContent = typeof value === "string" ? JSON.stringify(value) : String(value); return node; };
  const node = (value, depth = 0, key) => {
    const wrap = document.createElement("div"); wrap.className = "json-node";
    if (key !== undefined) { const label = document.createElement("span"); label.className = "json-key"; label.textContent = `${key}: `; wrap.append(label); }
    if (!value || typeof value !== "object") { wrap.append(scalar(value)); return wrap; }
    const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
    const details = document.createElement("details"), summary = document.createElement("summary"), children = document.createElement("div");
    details.open = depth < 2; summary.textContent = `${Array.isArray(value) ? "Array" : "Object"} (${entries.length})`; children.className = "json-children";
    entries.forEach(([childKey, child]) => children.append(node(child, depth + 1, childKey)));
    details.append(summary, children); wrap.append(details); return wrap;
  };
  const build = ({ source }) => {
    if (source.length > MAX_SOURCE) return null;
    let parsed; try { parsed = JSON.parse(source); } catch { return null; }
    if (!valid(parsed)) return null;
    const view = document.createElement("div"); view.className = "json-view"; view.append(node(parsed));
    return { nodes: [view] };
  };
  window.ResponseViewerJson = { build, valid };
  window.ResponseViewerFences.register("json", build);
})();
