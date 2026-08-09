/* Local reader interaction. Markdown insertions are sanitized by renderer.js before assignment. */
(() => {
  const $ = id => document.getElementById(id);
  const body = $("response-body"), outline = $("outline-links"), outlinePanel = $("response-outline"), status = $("status"), title = $("response-title"), meta = $("response-meta"), newContent = $("new-content"), toolbar = document.querySelector(".toolbar"), historyControl = $("history-control"), previous = $("previous-response"), next = $("next-response"), historyPosition = $("history-position"), navigatorPanel = $("response-navigator"), navigatorRoot = $("navigator-list"), navigatorInput = $("navigator-search"), navigatorCount = $("navigator-count"), matchControls = $("navigator-match-controls"), previousMatch = $("previous-match"), nextMatch = $("next-match"), matchCount = $("navigator-match-count");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)"), narrow = matchMedia("(max-width: 1180px)");
  let raw = "", renderedId = null, revision = -1, following = true, events, destroyed = false, reconnecting = false, scrollGuardUntil = 0, scrollRaf = 0, followRaf = 0, toggleRaf = 0, renderTimer = 0, pendingHash = "", outlineInitialized = false, headings = [], activeLink, snapshot, selectedId = null, pendingRender, responseNavigator, exporter, matchSelection, bodySearchCache;
  const codePreferences = new Map(), maxCodePreferences = 256, MAX_SPECIAL_FENCES = 64, MAX_TOOL_FENCES = 256, promptExpansions = new Set();
  const rememberCodePreference = (responseId, index, patch) => { let response = codePreferences.get(responseId); if (!response) { response = new Map(); codePreferences.set(responseId, response); } let preference = response.get(index); if (!preference) { if (response.size >= maxCodePreferences) return; preference = { wrapped: false, expanded: false }; response.set(index, preference); } Object.assign(preference, patch); if (!preference.wrapped && !preference.expanded) response.delete(index); if (!response.size) codePreferences.delete(responseId); };
  const pruneCodePreferences = responses => { const ids = new Set(responses.map(response => response.id)); for (const id of codePreferences.keys()) if (!ids.has(id)) codePreferences.delete(id); for (const id of promptExpansions) if (!ids.has(id)) promptExpansions.delete(id); };
  const announce = text => { status.textContent = text; };
  const nearBottom = () => innerHeight + scrollY >= document.documentElement.scrollHeight - 140;
  const pauseFollow = () => { following = false; };
  const scrollLatest = explicit => { following = true; newContent.hidden = true; scrollGuardUntil = performance.now() + (explicit && !reducedMotion.matches ? 900 : 80); scrollTo({ top: document.documentElement.scrollHeight, behavior: explicit && !reducedMotion.matches ? "smooth" : "auto" }); if (explicit) announce("Following the latest response."); };
  const safeHash = () => { try { return location.hash ? decodeURIComponent(location.hash.slice(1)) : ""; } catch { return ""; } };
  pendingHash = safeHash();
  const setOutlineOpen = () => { if (!outlineInitialized) { outlinePanel.open = !narrow.matches; outlineInitialized = true; } };
  setOutlineOpen();
  const spyOffset = () => { const margin = parseFloat(getComputedStyle(headings[0] || body).scrollMarginTop) || 0; const toolbarClearance = (toolbar?.getBoundingClientRect().height || 0) + 18; return Math.max(margin + 2, toolbarClearance); };
  const revealActive = link => { if (!link || !outlinePanel.open) return; const listRect = outline.getBoundingClientRect(), linkRect = link.getBoundingClientRect(); if (linkRect.top < listRect.top) outline.scrollTop += linkRect.top - listRect.top; else if (linkRect.bottom > listRect.bottom) outline.scrollTop += linkRect.bottom - listRect.bottom; };
  const setActive = id => { const link = id ? outline.querySelector(`a[href="#${CSS.escape(id)}"]`) : outline.querySelector("a"); if (!link || link === activeLink) return; for (const item of outline.querySelectorAll("a")) item.setAttribute("aria-current", String(item === link)); activeLink = link; revealActive(link); };
  const syncActive = () => { scrollRaf = 0; if (destroyed) return; if (performance.now() >= scrollGuardUntil) { if (nearBottom()) { following = true; newContent.hidden = true; } else following = false; } const offset = spyOffset(), passed = headings.filter(h => h.isConnected && h.getBoundingClientRect().top <= offset); setActive((passed.at(-1) || headings.find(h => h.isConnected))?.id); };
  const scheduleSync = () => { if (!scrollRaf) scrollRaf = requestAnimationFrame(syncActive); };
  const navigateTo = target => { pauseFollow(); scrollGuardUntil = performance.now() + 160; target.scrollIntoView({ block: "start", behavior: "instant" }); setActive(target.id); scheduleSync(); };
  const jumpToHash = () => { const id = pendingHash; if (!id) return false; const target = headings.find(h => h.id === id); if (!target) return false; pendingHash = ""; navigateTo(target); return true; };
  const hashNavigation = () => { const id = safeHash(); if (!id) return; pendingHash = id; pauseFollow(); jumpToHash(); };
  const mediaChange = () => { navigatorPanel.open = !narrow.matches; scheduleSync(); };
  navigatorPanel.open = !narrow.matches;
  const outlineToggle = () => { if (!outlinePanel.open) return; if (toggleRaf) cancelAnimationFrame(toggleRaf); toggleRaf = requestAnimationFrame(() => { toggleRaf = 0; if (!destroyed) revealActive(activeLink); }); };
  addEventListener("scroll", scheduleSync, { passive: true }); addEventListener("hashchange", hashNavigation); narrow.addEventListener("change", mediaChange); outlinePanel.addEventListener("toggle", outlineToggle);
  newContent.addEventListener("click", () => scrollLatest(true));
  $("theme-toggle").addEventListener("click", () => { const dark = document.documentElement.dataset.theme === "dark"; document.documentElement.dataset.theme = dark ? "light" : "dark"; window.ResponseViewerMermaid.onThemeChange(); announce(`Switched to ${dark ? "light" : "dark"} theme.`); });
  const copy = async (text, button) => { let done = false; try { await navigator.clipboard.writeText(text); done = true; } catch { const area = document.createElement("textarea"); area.value = text; area.style.cssText = "position:fixed;opacity:0"; document.body.append(area); area.select(); try { done = document.execCommand("copy"); } catch {} area.remove(); } const label = button.textContent; button.textContent = done ? "Copied" : "Copy failed"; announce(done ? "Copied to clipboard." : "Copy failed. Clipboard access was unavailable."); setTimeout(() => { button.textContent = label; }, 1200); };
  const slug = (text, used) => { const base = text.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/[\s-]+/g, "-") || "section"; let id = base, n = 2; while (used.has(id)) id = `${base}-${n++}`; used.add(id); return id; };
  const decorate = responseId => {
    const used = new Set(), allHeadings = [...body.querySelectorAll("h1,h2,h3,h4,h5,h6")], labels = new Map(allHeadings.map(h => [h, h.textContent || "Section"]));
    allHeadings.forEach(h => { const text = labels.get(h) || "Section"; h.id = slug(text, used); const link = document.createElement("a"); link.className = "heading-link"; link.href = `#${h.id}`; link.setAttribute("aria-label", `Link to ${text}`); link.textContent = "#"; link.addEventListener("click", pauseFollow); h.append(link); });
    headings = allHeadings.filter(h => h.matches("h1,h2,h3")); outline.replaceChildren(); headings.forEach(h => { const link = document.createElement("a"), text = labels.get(h) || "Section"; link.href = `#${h.id}`; link.textContent = text; link.title = text; link.dataset.level = h.tagName.slice(1); link.addEventListener("click", () => { pauseFollow(); scrollGuardUntil = performance.now() + 160; }); outline.append(link); });
    let specialFenceCount = 0, toolFenceCount = 0;
    body.querySelectorAll("pre").forEach((pre, index) => {
      const code = pre.querySelector("code"), plain = code?.textContent || "", language = code && window.ResponseViewerSyntax.languageFromCode(code), canonical = window.ResponseViewerSyntax.canonical(language), preference = codePreferences.get(responseId)?.get(index), wrapper = document.createElement("div"), label = document.createElement("div"), name = document.createElement("span"), actions = document.createElement("span");
      wrapper.className = "code-block"; label.className = "code-label"; name.className = "code-language"; name.textContent = code?.getAttribute("title") || canonical; name.title = canonical; actions.className = "code-actions";
      const action = (className, text, aria) => { const button = document.createElement("button"); button.className = className; button.type = "button"; button.textContent = text; button.setAttribute("aria-label", aria); actions.append(button); return button; };
      const copyButton = action("copy-code", "Copy", "Copy code"); copyButton.addEventListener("click", () => copy(plain, copyButton));
      const isContextFence = language && (language[0] === "pi-tool" || language[0] === "pi-think");
      const budgetLeft = isContextFence ? toolFenceCount < MAX_TOOL_FENCES : specialFenceCount < MAX_SPECIAL_FENCES;
      const special = budgetLeft && language && window.ResponseViewerFences.render(language[0], { source: plain, pre });
      if (special && isContextFence) toolFenceCount += 1; else if (special) specialFenceCount += 1;
      // A viewer fence the renderer declined — over the fence budget, or over a renderer's size gate —
      // must not fall through to the ordinary code-block branch: its payload carries the session nonce,
      // which would then be shown as page text and wired to the Copy button. A fence that does not carry
      // the nonce is assistant text impersonating a step, and still renders as an ordinary code block.
      const sessionNonce = typeof window.ResponseViewerNonce === "string" ? window.ResponseViewerNonce : "";
      const hidden = Boolean(isContextFence && !special && sessionNonce && plain.includes(sessionNonce));
      if (!special && !hidden) {
        const wrapButton = action("code-action code-wrap-toggle", "Wrap", "Wrap code lines"); const wrapped = Boolean(preference?.wrapped); pre.classList.toggle("code-wrapped", wrapped); wrapButton.setAttribute("aria-pressed", String(wrapped)); wrapButton.addEventListener("click", () => { const next = pre.classList.toggle("code-wrapped"); wrapButton.setAttribute("aria-pressed", String(next)); rememberCodePreference(responseId, index, { wrapped: next }); });
        const lines = plain ? plain.split(/\r?\n/).length : 1; if (lines > 24) { const expanded = Boolean(preference?.expanded); pre.classList.toggle("code-expanded", expanded); pre.classList.toggle("code-collapsed", !expanded); const expandButton = action("code-action code-expand-toggle", expanded ? "Collapse" : "Expand", expanded ? "Collapse code block" : "Expand code block"); expandButton.setAttribute("aria-expanded", String(expanded)); expandButton.addEventListener("click", () => { const next = pre.classList.toggle("code-expanded"); pre.classList.toggle("code-collapsed", !next); expandButton.textContent = next ? "Collapse" : "Expand"; expandButton.setAttribute("aria-expanded", String(next)); expandButton.setAttribute("aria-label", next ? "Collapse code block" : "Expand code block"); rememberCodePreference(responseId, index, { expanded: next }); }); }
      }
      if (code && !hidden) code.replaceChildren(window.ResponseViewerSyntax.highlight(plain, language));
      label.append(name, actions); pre.replaceWith(wrapper);
      if (hidden) { wrapper.className = "context-block"; const note = document.createElement("div"); note.className = "context-hidden"; note.textContent = language[0] === "pi-tool" ? "Tool step hidden (viewer limit reached)" : "Thinking hidden (viewer limit reached)"; wrapper.append(note); }
      else if (special && special.bare) { wrapper.className = "context-block"; wrapper.append(...special.nodes); }
      else if (special) wrapper.append(label, ...special.nodes);
      else wrapper.append(label, pre);
    });
    body.querySelectorAll("table").forEach(table => { if (table.closest(".csv-view")) return; const wrap = document.createElement("div"); wrap.className = "table-wrap"; table.replaceWith(wrap); wrap.append(table); });
  };
  const clearSearchHighlights = () => {
    for (const mark of body.querySelectorAll("mark.response-search-match")) {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent || ""));
      parent?.normalize();
    }
  };
  const bodyMatches = query => {
    const map = window.ResponseViewerNavigator.visibleMap(body), needle = window.ResponseViewerNavigator.foldedNeedle(query);
    if (!bodySearchCache || bodySearchCache.text !== map.text || bodySearchCache.query !== query) bodySearchCache = { text: map.text, query, ranges: window.ResponseViewerNavigator.ranges(window.ResponseViewerNavigator.foldedText(map.text), needle, window.ResponseViewerNavigator.MAX_MATCHES + 1) };
    return { map, ranges: bodySearchCache.ranges };
  };
  const matchData = () => responseNavigator?.matches?.() || { matches: [], capped: false };
  const matchIndex = data => {
    if (!matchSelection) return -1;
    let index = data.matches.findIndex(match => match.responseId === matchSelection.responseId && match.start === matchSelection.start && match.end === matchSelection.end);
    if (index < 0) index = data.matches.findIndex(match => match.responseId === matchSelection.responseId && match.occurrence === matchSelection.occurrence);
    if (index >= 0) matchSelection = data.matches[index]; else matchSelection = undefined;
    return index;
  };
  const updateMatchControls = () => {
    const query = navigatorInput.value.trim(), data = matchData(), index = matchIndex(data), total = data.matches.length;
    matchControls.hidden = !query;
    previousMatch.disabled = !total; nextMatch.disabled = !total;
    if (!query) { matchCount.textContent = ""; return; }
    matchCount.textContent = `${index + 1} of ${total}${data.capped ? "+" : ""} matches`;
  };
  const expandMatchContainers = marks => {
    for (const mark of marks) {
      for (let details = mark.closest("details"); details; details = details.parentElement?.closest("details")) details.open = true;
      const pre = mark.closest("pre.code-collapsed");
      // Use the existing action rather than changing its classes directly so the per-response code
      // preference survives the next streaming render just like an explicit user expansion.
      pre?.closest(".code-block")?.querySelector(".code-expand-toggle")?.click();
    }
  };
  const applyCurrentMatch = scroll => {
    clearSearchHighlights();
    if (!matchSelection || matchSelection.responseId !== selectedId) return false;
    const query = navigatorInput.value.trim(); if (!query) return false;
    const matched = bodyMatches(query);
    // Prefer the original offsets; after safe DOM reordering (for example CSV sort) the same
    // per-response occurrence remains a deterministic target. Never clamp to a different hit.
    const target = matched.ranges.find(range => range.start === matchSelection.start && range.end === matchSelection.end) || matched.ranges[matchSelection.occurrence];
    if (!target) return false;
    const fragments = matched.map.segments.filter(segment => segment.start < target.end && segment.end > target.start);
    if (!fragments.length) return false;
    const marks = [];
    for (const segment of fragments.reverse()) {
      const range = document.createRange(), start = Math.max(target.start, segment.start) - segment.start, end = Math.min(target.end, segment.end) - segment.start;
      range.setStart(segment.node, start); range.setEnd(segment.node, end);
      const mark = document.createElement("mark"); mark.className = "response-search-match"; range.surroundContents(mark); marks.unshift(mark);
    }
    expandMatchContainers(marks);
    if (scroll) marks[0].scrollIntoView({ block: "center", behavior: reducedMotion.matches ? "auto" : "smooth" });
    return true;
  };
  const restoreCurrentMatch = scroll => { updateMatchControls(); return applyCurrentMatch(scroll); };
  const navigateMatches = direction => {
    const data = matchData(), total = data.matches.length;
    if (!total) return;
    const index = matchIndex(data), nextIndex = index < 0 ? (direction > 0 ? 0 : total - 1) : (index + direction + total) % total;
    matchSelection = data.matches[nextIndex];
    selectResponse(matchSelection.responseId, matchSelection);
    announce(`Match ${nextIndex + 1} of ${total}${data.capped ? " or more" : ""}.`);
  };
  const onSearchInput = () => { matchSelection = undefined; clearSearchHighlights(); if (!navigatorInput.value.trim()) bodySearchCache = undefined; updateMatchControls(); };
  const onSearchKeydown = event => {
    if (event.key !== "Enter") return;
    event.preventDefault(); navigateMatches(event.shiftKey ? -1 : 1);
  };
  const onPreviousMatch = () => navigateMatches(-1), onNextMatch = () => navigateMatches(1);
  const selected = () => snapshot?.responses?.find(response => response?.id === selectedId);
  // A viewer fence is exactly three lines — opener, single-line JSON payload, closer — and that
  // payload's first key is the session nonce. Skipping only the delimiter lines would return the
  // payload itself as the preview, printing the nonce as visible page text.
  const VIEWER_OPENER = /^\s*```(?:pi-tool|pi-think)\s*$/;
  const firstProse = value => { const lines = String(value || "").split(/\r?\n/); for (let index = 0; index < lines.length; index += 1) { if (VIEWER_OPENER.test(lines[index])) { index += 1; continue; } if (lines[index].trim() && !/^\s*```/.test(lines[index])) return lines[index]; } return ""; };
  const concise = value => firstProse(value).replace(/<[^>]*>/g, "").replace(/!?(\[[^\]]*\])\([^)]*\)/g, "$1").replace(/^[\s>#*`~\-\d.)]+/, "").replace(/[\*_`~]/g, "").trim().replace(/\s+/g, " ").slice(0, 80) || "Response viewer";
  // The prompt comes first, as in the navigator's own label: it names the turn, and for a turn that
  // opens with thinking or a tool call the body has nothing quotable to fall back to.
  const responseLabel = response => response?.prompt?.text ? concise(response.prompt.text) : headings[0]?.textContent?.replace(/#$/, "").trim() || concise(response?.markdown);
  const titlePrefix = response => reconnecting ? "Reconnecting" : response?.status === "error" ? "Response error" : response?.id !== snapshot?.latestId ? "Previous" : response?.status === "running" ? "Receiving" : "Response";
  const updateChrome = () => {
    const responses = Array.isArray(snapshot?.responses) ? snapshot.responses : [], response = selected(), index = responses.findIndex(item => item.id === selectedId), older = response && response.id !== snapshot?.latestId;
    historyControl.hidden = responses.length <= 1; historyPosition.textContent = index >= 0 ? `${index + 1} / ${responses.length}` : ""; previous.disabled = index <= 0; next.disabled = index < 0 || index >= responses.length - 1;
    const base = reconnecting ? "Reconnecting…" : !response ? "Waiting for a response" : older ? `Previous response · ${index + 1} of ${responses.length}` : response.status === "running" ? "Receiving response…" : response.status === "error" ? "Response ended with an error" : `Latest response · ${index + 1} of ${responses.length}`;
    meta.textContent = `${base}${response?.truncated ? " · Response truncated" : ""}`; title.textContent = !response ? "Response viewer" : older ? "Previous response" : response.status === "running" ? "Receiving response" : "Response viewer";
    document.title = `${titlePrefix(response)}: ${responseLabel(response)}`;
  };
  const cadence = markdown => markdown.length < 8_000 ? 80 : markdown.length < 32_000 ? 140 : markdown.length < 128_000 ? 250 : 400;
  const renderNow = () => {
    if (destroyed || !snapshot) return; if (renderTimer) { clearTimeout(renderTimer); renderTimer = 0; } pendingRender = undefined;
    const response = selected(); if (!response) { raw = ""; renderedId = null; body.replaceChildren(); headings = []; outline.replaceChildren(); updateChrome(); return; }
    const identityChanged = renderedId !== response.id, changed = identityChanged || raw !== response.markdown, wasFollowing = following && nearBottom();
    let hashHandled = false;
    if (changed) {
      raw = response.markdown; renderedId = response.id; bodySearchCache = undefined; body.innerHTML = window.ResponseViewerRenderer.render(raw);
      if (response.prompt && response.prompt.text) {
        const header = document.createElement("div"); header.className = "response-prompt";
        const text = document.createElement("div"); text.className = "response-prompt-text"; text.textContent = response.prompt.text;
        header.append(text);
        // truncateUtf8 cuts at a byte boundary with no marker, so an expanded prompt would otherwise
        // read as complete. The response body surfaces the same state in the chrome bar.
        if (response.prompt.truncated) {
          const cut = document.createElement("span"); cut.className = "response-prompt-cut";
          cut.textContent = "… prompt truncated, see terminal";
          header.append(cut);
        }
        if (response.prompt.truncated || response.prompt.text.split(/\r?\n/).length > 3 || response.prompt.text.length > 200) {
          const open = promptExpansions.has(response.id);
          header.classList.toggle("response-prompt-open", open);
          const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "response-prompt-toggle";
          toggle.textContent = open ? "Show less" : "Show more"; toggle.setAttribute("aria-expanded", String(open));
          toggle.addEventListener("click", () => {
            const next = header.classList.toggle("response-prompt-open");
            if (next) promptExpansions.add(response.id); else promptExpansions.delete(response.id);
            toggle.textContent = next ? "Show less" : "Show more";
            toggle.setAttribute("aria-expanded", String(next));
          });
          header.append(toggle);
        } else header.classList.add("response-prompt-open");
        body.prepend(header);
      }
      decorate(response.id); hashHandled = jumpToHash();
    }
    // A missing fragment must not suppress follow or survive into another response.
    if ((response.status === "complete" || response.status === "error") && pendingHash) clearHash();
    if (changed && matchSelection?.responseId === response.id) applyCurrentMatch(false);
    if (changed && !hashHandled && !pendingHash && !identityChanged && wasFollowing && response.id === snapshot.latestId) { if (followRaf) cancelAnimationFrame(followRaf); followRaf = requestAnimationFrame(() => { followRaf = 0; if (!destroyed && following) scrollLatest(false); }); } else if (changed && !hashHandled && !pendingHash && !wasFollowing && response.id === snapshot.latestId) { following = false; newContent.hidden = false; } if (changed) scheduleSync();
    if (response.error) announce(response.error); updateChrome();
  };
  const scheduleRender = () => { pendingRender = snapshot; if (renderTimer || destroyed) return; renderTimer = setTimeout(() => { renderTimer = 0; if (pendingRender) renderNow(); }, cadence(selected()?.markdown || "")); };
  const clearHash = () => { pendingHash = ""; if (!location.hash) return; history.replaceState(null, "", `${location.pathname}${location.search}`); };
  const selectResponse = (id, match) => {
    if (!snapshot?.responses?.some(response => response.id === id)) return;
    if (!match) { matchSelection = undefined; clearSearchHighlights(); updateMatchControls(); }
    selectedId = id; pauseFollow(); newContent.hidden = true; clearHash(); renderNow(); responseNavigator?.update(snapshot, selectedId);
    if (match) { matchSelection = match; restoreCurrentMatch(true); }
    else document.querySelector(".response-header")?.scrollIntoView({ block: "start", behavior: "instant" });
  };
  const choose = direction => { const responses = snapshot?.responses || [], index = responses.findIndex(response => response.id === selectedId), nextIndex = index + direction; if (nextIndex < 0 || nextIndex >= responses.length) return; selectResponse(responses[nextIndex].id); };
  responseNavigator = window.ResponseViewerNavigator.create({ root: navigatorRoot, input: navigatorInput, count: navigatorCount, select: selectResponse });
  navigatorInput.addEventListener("input", onSearchInput); navigatorInput.addEventListener("keydown", onSearchKeydown);
  previousMatch.addEventListener("click", onPreviousMatch); nextMatch.addEventListener("click", onNextMatch);
  const copyResponse = $("copy-response");
  exporter = window.ResponseViewerExport.create({ getSnapshot: () => snapshot, getSelected: () => selectedId, getCurrentBody: () => body, copy, render: window.ResponseViewerRenderer.render });
  copyResponse.addEventListener("click", () => exporter.copyCurrent(copyResponse)); $("download-response").addEventListener("click", () => exporter.downloadCurrent()); $("download-history").addEventListener("click", () => exporter.downloadAll()); $("print-response").addEventListener("click", () => exporter.printCurrent()); $("print-history").addEventListener("click", () => exporter.printAll());
  const commandSearch = event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); responseNavigator.focus(); } }; addEventListener("keydown", commandSearch);
  previous.addEventListener("click", () => choose(-1)); next.addEventListener("click", () => choose(1));
  const cleanup = () => { if (destroyed) return; destroyed = true; if (events) events.close(); if (renderTimer) clearTimeout(renderTimer); if (scrollRaf) cancelAnimationFrame(scrollRaf); if (followRaf) cancelAnimationFrame(followRaf); if (toggleRaf) cancelAnimationFrame(toggleRaf); headings = []; activeLink = undefined; codePreferences.clear(); promptExpansions.clear(); clearSearchHighlights(); responseNavigator?.destroy(); exporter?.destroy(); navigatorInput.removeEventListener("input", onSearchInput); navigatorInput.removeEventListener("keydown", onSearchKeydown); previousMatch.removeEventListener("click", onPreviousMatch); nextMatch.removeEventListener("click", onNextMatch); removeEventListener("keydown", commandSearch); removeEventListener("scroll", scheduleSync); removeEventListener("hashchange", hashNavigation); narrow.removeEventListener("change", mediaChange); outlinePanel.removeEventListener("toggle", outlineToggle); };
  const receive = nextSnapshot => {
    if (!nextSnapshot || destroyed) return; if (nextSnapshot.status === "closed") { cleanup(); return; } if (nextSnapshot.revision <= revision) return;
    const priorLatest = snapshot?.latestId, priorSelected = selectedId, wasReconnecting = reconnecting; snapshot = nextSnapshot; revision = nextSnapshot.revision;
    window.ResponseViewerNonce = typeof snapshot.nonce === "string" ? snapshot.nonce : undefined;
    const responses = Array.isArray(snapshot.responses) ? snapshot.responses.filter(response => response && typeof response.id === "string") : [];
    pruneCodePreferences(responses);
    if (!selectedId) selectedId = snapshot.latestId || responses.at(-1)?.id || null;
    else if (priorSelected === priorLatest && snapshot.latestId && snapshot.latestId !== priorLatest) selectedId = snapshot.latestId;
    else if (!responses.some(response => response.id === selectedId)) selectedId = responses[0]?.id || snapshot.latestId || null;
    if (selectedId !== priorSelected) { matchSelection = undefined; clearSearchHighlights(); }
    responseNavigator?.update(snapshot, selectedId); updateMatchControls();
    const response = selected(), selectedChanged = selectedId !== renderedId;
    // The initial response owns an incoming deep link; later response changes do not.
    if (selectedChanged && renderedId !== null) clearHash();
    const immediate = !renderedId || selectedChanged || wasReconnecting || response?.status !== "running" || response?.markdown === raw;
    updateChrome();
    if (!response) renderNow(); else if (immediate) renderNow(); else if (response.id === snapshot.latestId) scheduleRender();
  };
  events = new EventSource("events");
  events.addEventListener("state", event => { try { receive(JSON.parse(event.data)); } catch { announce("Viewer update could not be read."); } });
  events.addEventListener("open", () => { if (!destroyed && reconnecting) { reconnecting = false; updateChrome(); renderNow(); } });
  events.addEventListener("error", () => { if (!destroyed) { reconnecting = true; updateChrome(); } });
})();
