/* First-party Mermaid wrapper: initialize, parse/render, SVG sanitize, bounded cache. */
(() => {
  let initializedTheme = null;
  const cache = new Map(); // key: `${theme} ${source}` -> sanitized SVG markup, or false for a known-bad source
  const hostSource = new WeakMap(); // host -> source, so a theme change can re-render in place
  const hostPre = new WeakMap(); // host -> its sibling pre, kept explicitly rather than relying on DOM order
  let counter = 0, epoch = 0;
  const ensureInitialized = () => {
    const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "default";
    if (theme !== initializedTheme) {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme, htmlLabels: false, flowchart: { htmlLabels: false } });
      initializedTheme = theme;
    }
    return theme;
  };
  const remember = (key, value) => { cache.set(key, value); if (cache.size > 64) cache.delete(cache.keys().next().value); };
  // Mermaid click directives can emit live anchors; they must pass the same policy as every Markdown link.
  const enforceLinkPolicy = host => host.querySelectorAll("a").forEach(a => {
    const link = window.ResponseViewerLinkPolicy.allowedHref(a.getAttribute("href") ?? a.getAttribute("xlink:href"));
    if (!link) { a.removeAttribute("href"); a.removeAttribute("xlink:href"); return; }
    if (link.external) { a.setAttribute("rel", "noreferrer noopener"); a.setAttribute("target", "_blank"); }
  });
  // Streaming replaces body.innerHTML per tick, so the host may be stale by the time the promise resolves;
  // the epoch guard keeps an in-flight render from injecting the previous theme after a toggle.
  const inject = (host, pre, svg, at) => { if (at !== epoch || !host.isConnected) return; host.innerHTML = svg; enforceLinkPolicy(host); host.hidden = false; pre.hidden = true; };
  const render = async (source, host, pre) => {
    hostSource.set(host, source);
    hostPre.set(host, pre);
    const theme = ensureInitialized(), key = `${theme} ${source}`, at = epoch;
    if (cache.has(key)) {
      const cached = cache.get(key);
      // build() runs before its host is attached; retry after that synchronous DOM work.
      if (cached !== false) queueMicrotask(() => inject(host, pre, cached, at));
      return;
    }
    const id = `rv-mermaid-${++counter}`;
    try {
      const ok = await mermaid.parse(source, { suppressErrors: true });
      if (!ok) { remember(key, false); return; }
      const { svg } = await mermaid.render(id, source);
      const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ["style"], FORBID_TAGS: ["foreignObject"], ADD_ATTR: ["transform-origin"] });
      remember(key, clean);
      inject(host, pre, clean, at);
    } catch {
      // mermaid.render can leave an orphan node under its own id when it throws mid-render.
      document.getElementById(id)?.remove();
      remember(key, false);
    }
  };
  const onThemeChange = () => {
    initializedTheme = null;
    epoch += 1;
    cache.clear();
    document.querySelectorAll(".code-block .mermaid-host").forEach(host => {
      const source = hostSource.get(host), pre = hostPre.get(host);
      if (source !== undefined && pre) render(source, host, pre);
    });
  };
  const build = ({ source, pre }) => {
    const host = document.createElement("div");
    host.className = "mermaid-host"; host.hidden = true;
    render(source, host, pre);
    return { nodes: [pre, host] };
  };
  window.ResponseViewerMermaid = { render, onThemeChange, build };
  window.ResponseViewerFences.register("mermaid", build);
})();
