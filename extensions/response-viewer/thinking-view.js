/* Collapsed thinking disclosure. The body is a text node, never markdown. */
(() => {
  // Node caps a raw tool result at 8 KiB, but JSON.stringify expands control bytes
  // (e.g. ANSI escapes in coloured command output) roughly 6x, so the browser-side
  // cap on the serialized payload must be larger than the Node-side raw-text cap.
  const MAX_SOURCE = 64 * 1024;
  const build = ({ source }) => {
    if (typeof source !== "string" || source.length > MAX_SOURCE) return null;
    const nonce = window.ResponseViewerNonce;
    if (typeof nonce !== "string" || !nonce) return null;
    let payload;
    try { payload = JSON.parse(source); } catch { return null; }
    if (!payload || typeof payload !== "object" || payload.nonce !== nonce) return null;
    const thinking = typeof payload.thinking === "string" ? payload.thinking : "";
    if (!thinking) return null;
    const details = document.createElement("details");
    details.className = "thinking-view";
    const label = document.createElement("summary");
    label.textContent = payload.truncated === true ? "Thinking (truncated, see terminal)" : "Thinking";
    const body = document.createElement("pre");
    body.textContent = thinking;
    details.append(label, body);
    return { nodes: [details], bare: true };
  };
  window.ResponseViewerThinking = { build };
  window.ResponseViewerFences.register("pi-think", build);
})();
