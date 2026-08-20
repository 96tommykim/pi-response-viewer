/* First-party Mermaid wrapper: initialize, parse/render, SVG sanitize, bounded cache, zoom/pan. */
(() => {
  let initializedTheme = null;
  const cache = new Map(); // key: `${theme} ${source}` -> sanitized SVG markup, or false for a known-bad source
  const hostSource = new WeakMap(); // host -> source, so a theme change can re-render in place
  const hostPre = new WeakMap(); // host -> its sibling pre, kept explicitly rather than relying on DOM order
  const hostControls = new WeakMap(); // host -> its zoom controls, re-attached after every innerHTML swap
  const view = new WeakMap(); // host -> { k, x, y }
  let counter = 0, epoch = 0;
  // The clamps sit on the button ladder, so a run that bottoms out still retraces back to 1.
  const ZOOM_STEP = 1.4, MIN_SCALE = ZOOM_STEP ** -3, MAX_SCALE = ZOOM_STEP ** 6;
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
  // Per host, so two renders of the same diagram never share a framing. A theme toggle reuses its
  // hosts and keeps the zoom; a streaming tick rebuilds them and starts from a fit.
  // ponytail: zoom resets if the turn re-renders while you are zoomed. Key it per response and
  // fence index like codePreferences in client.js if that becomes annoying mid-stream.
  const state = host => { let current = view.get(host); if (!current) { current = { k: 1, x: 0, y: 0 }; view.set(host, current); } return current; };
  const expanded = host => document.fullscreenElement?.contains(host) === true;
  // Float drift and a clamped step both land near 1 without hitting it, and an exact comparison
  // would leave the grab cursor and drag-panning armed over a diagram that reads as untouched.
  const zoomed = host => Math.abs(state(host).k - 1) > 0.005 || expanded(host);
  const apply = host => {
    const svg = host.querySelector("svg"); if (!svg) return;
    const at = state(host);
    svg.style.transformOrigin = "0 0";
    svg.style.transform = `translate(${at.x}px, ${at.y}px) scale(${at.k})`;
    host.classList.toggle("mermaid-zoomed", zoomed(host));
  };
  // Keep the point under the cursor fixed: with transform-origin at 0 0 the live rect's top-left
  // is exactly the current translation, so the anchor needs no padding or layout arithmetic.
  const zoomTo = (host, target, clientX, clientY) => {
    const svg = host.querySelector("svg"); if (!svg) return;
    const at = state(host), next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, target));
    if (next === at.k) return;
    const rect = svg.getBoundingClientRect(), ratio = next / at.k;
    const anchorX = clientX ?? rect.left + rect.width / 2, anchorY = clientY ?? rect.top + rect.height / 2;
    at.x -= (anchorX - rect.left) * (ratio - 1);
    at.y -= (anchorY - rect.top) * (ratio - 1);
    at.k = next;
    apply(host);
  };
  const reset = host => { const at = state(host); at.k = 1; at.x = 0; at.y = 0; apply(host); };
  // Full screen relocates the svg's layout origin, so a framing chosen on one side of the
  // transition is meaningless on the other — including an Escape-key exit.
  let expandedBlock = null;
  document.addEventListener("fullscreenchange", () => {
    const affected = document.fullscreenElement || expandedBlock;
    expandedBlock = document.fullscreenElement;
    affected?.querySelectorAll?.(".mermaid-host").forEach(reset);
  });
  const toggleFullscreen = host => {
    if (expanded(host)) document.exitFullscreen?.()?.catch(() => {});
    else (host.closest(".code-block") || host).requestFullscreen?.()?.catch(() => {});
  };
  const buildControls = host => {
    const controls = document.createElement("div");
    controls.className = "mermaid-controls";
    // The gesture hint rides on the button the reader is most likely to hover, since a tooltip on
    // the diagram itself would pop up through every read of it.
    const button = (text, label, action, hint) => {
      const item = document.createElement("button");
      item.type = "button"; item.className = "code-action"; item.textContent = text;
      item.setAttribute("aria-label", label); item.title = hint || label;
      item.addEventListener("click", action);
      controls.append(item);
    };
    button("−", "Zoom out", () => zoomTo(host, state(host).k / ZOOM_STEP));
    button("+", "Zoom in", () => zoomTo(host, state(host).k * ZOOM_STEP), "Zoom in · Ctrl/⌘ + scroll to zoom, drag to pan, double-click to reset");
    button("Fit", "Reset zoom", () => reset(host));
    button("⛶", "Toggle full screen", () => toggleFullscreen(host));
    return controls;
  };
  const bindGestures = host => {
    // Plain wheel keeps scrolling the page; the pinch gesture arrives as ctrl+wheel, and inside
    // full screen there is no page left to scroll, so the bare wheel zooms there.
    host.addEventListener("wheel", event => {
      if (!(event.ctrlKey || event.metaKey || expanded(host))) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
      zoomTo(host, state(host).k * Math.exp(-delta * 0.002), event.clientX, event.clientY);
    }, { passive: false });
    host.addEventListener("dblclick", event => { if (!event.target.closest?.("button")) reset(host); });
    let pan = null;
    host.addEventListener("pointerdown", event => {
      // Drag pans only once zoomed, so label selection and click directives still work at rest.
      if (event.button !== 0 || !host.querySelector("svg") || event.target.closest?.("a,button")) return;
      if (!zoomed(host)) return;
      pan = { id: event.pointerId, x: event.clientX, y: event.clientY };
      // A synthetic pointer has no active capture target; losing capture must not lose the drag.
      try { host.setPointerCapture(event.pointerId); } catch {}
      host.classList.add("mermaid-panning");
      event.preventDefault();
    });
    host.addEventListener("pointermove", event => {
      if (!pan || event.pointerId !== pan.id) return;
      if (!event.buttons) { pan = null; host.classList.remove("mermaid-panning"); return; }
      const at = state(host);
      at.x += event.clientX - pan.x; at.y += event.clientY - pan.y;
      pan.x = event.clientX; pan.y = event.clientY;
      apply(host);
    });
    const endPan = event => { if (pan && event.pointerId === pan.id) { pan = null; host.classList.remove("mermaid-panning"); } };
    host.addEventListener("pointerup", endPan);
    host.addEventListener("pointercancel", endPan);
  };
  // Streaming replaces body.innerHTML per tick, so the host may be stale by the time the promise resolves;
  // the epoch guard keeps an in-flight render from injecting the previous theme after a toggle.
  const inject = (host, pre, svg, at) => {
    if (at !== epoch || !host.isConnected) return;
    host.innerHTML = svg;
    enforceLinkPolicy(host);
    // The controls live inside the host so the search projection skips them and full screen keeps
    // them on screen; innerHTML above drops them, so re-attach on every injection.
    const controls = hostControls.get(host); if (controls) host.append(controls);
    apply(host);
    host.hidden = false; pre.hidden = true;
  };
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
    hostControls.set(host, buildControls(host));
    bindGestures(host);
    render(source, host, pre);
    return { nodes: [pre, host] };
  };
  window.ResponseViewerMermaid = { render, onThemeChange, build };
  window.ResponseViewerFences.register("mermaid", build);
})();
