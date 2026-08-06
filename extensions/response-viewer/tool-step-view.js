/* Tool step chips. Every value is inserted as a text node; nothing here is parsed as markup. */
(() => {
  // Node caps a raw tool result at 8 KiB, but JSON.stringify expands control bytes
  // (e.g. ANSI escapes in coloured command output) roughly 6x, so the browser-side
  // cap on the serialized payload must be larger than the Node-side raw-text cap.
  const MAX_RESULT = 64 * 1024;
  const GLYPH = { running: "⏳", ok: "✓", error: "✗" };
  const payloadOf = source => {
    if (typeof source !== "string" || source.length > MAX_RESULT) return null;
    const nonce = window.ResponseViewerNonce;
    if (typeof nonce !== "string" || !nonce) return null;
    try {
      const value = JSON.parse(source);
      if (!value || typeof value !== "object") return null;
      if (value.nonce !== nonce) return null;
      if (value.status !== "running" && value.status !== "ok" && value.status !== "error") return null;
      return value;
    } catch { return null; }
  };
  const build = ({ source }) => {
    const step = payloadOf(source);
    if (!step) return null;
    const view = document.createElement("div");
    view.className = `tool-step tool-step-${step.status}`;
    const row = document.createElement("div");
    row.className = "tool-step-row";
    const glyph = document.createElement("span");
    glyph.className = "tool-step-glyph";
    glyph.textContent = GLYPH[step.status];
    glyph.setAttribute("aria-label", step.status);
    const name = document.createElement("span");
    name.className = "tool-step-name";
    name.textContent = typeof step.name === "string" ? step.name : "tool";
    const summary = document.createElement("span");
    summary.className = "tool-step-summary";
    summary.textContent = typeof step.summary === "string" ? step.summary : "";
    summary.title = summary.textContent;
    row.append(glyph, name, summary);
    view.append(row);
    const result = typeof step.result === "string" ? step.result : "";
    if (result) {
      const details = document.createElement("details");
      details.className = "tool-step-result";
      const label = document.createElement("summary");
      label.textContent = step.truncated === true ? "Result (truncated, see terminal)" : "Result";
      const body = document.createElement("pre");
      body.textContent = result;
      details.append(label, body);
      view.append(details);
    }
    return { nodes: [view], bare: true };
  };
  window.ResponseViewerToolStep = { build };
  window.ResponseViewerFences.register("pi-tool", build);
})();
