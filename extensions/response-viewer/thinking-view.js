/* Collapsed thinking disclosure. The body is a text node, never markdown. */
(() => {
  const MAX_SOURCE = 16 * 1024;
  const build = ({ source }) => {
    if (typeof source !== "string" || source.length > MAX_SOURCE) return null;
    let payload;
    try { payload = JSON.parse(source); } catch { return null; }
    if (!payload || typeof payload !== "object" || payload.nonce !== window.ResponseViewerNonce) return null;
    const thinking = typeof payload.thinking === "string" ? payload.thinking : "";
    if (!thinking) return null;
    const details = document.createElement("details");
    details.className = "thinking-view";
    const label = document.createElement("summary");
    label.textContent = payload.truncated ? "Thinking (truncated, see terminal)" : "Thinking";
    const body = document.createElement("pre");
    body.textContent = thinking;
    details.append(label, body);
    return { nodes: [details], bare: true };
  };
  window.ResponseViewerThinking = { build };
  window.ResponseViewerFences.register("pi-think", build);
})();
