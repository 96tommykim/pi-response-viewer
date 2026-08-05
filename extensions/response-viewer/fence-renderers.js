/* Safe, bounded registry for first-party rich fenced-code views. */
(() => {
  const MAX_SOURCE = 256 * 1024;
  const renderers = new Map();
  const register = (language, renderer) => {
    if (typeof language === "string" && typeof renderer === "function") renderers.set(language, renderer);
  };
  const render = (language, context) => {
    if (!language || typeof context?.source !== "string" || context.source.length > MAX_SOURCE) return null;
    try {
      const result = renderers.get(language)?.(context);
      return result && result.nodes ? result : null;
    } catch { return null; }
  };
  window.ResponseViewerFences = { register, render, MAX_SOURCE };
})();
