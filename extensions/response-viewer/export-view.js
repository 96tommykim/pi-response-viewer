/* Explicit, local-only copy/download/print actions over the current bounded snapshot. */
(() => {
  const filename = value => (String(value || "response").replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "response");
  // Viewer-private fences are meaningless outside the reader; flatten them to plain lines.
  // The print-all path re-renders this string as markdown, so every tool- and user-derived
  // value is emitted literally: indented blocks, and no interpolation into markdown syntax.
  const literalBlock = text => text.split(/\r?\n/).map(line => `    ${line}`).join("\n");
  // Tool names come from Pi's own registry, but a name is the one value interpolated into markdown
  // syntax, and a newline in it would let the following line become a real heading. Flatten it.
  const inlineText = text => String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  const cutNote = flag => flag === true ? "\n\n    … truncated, see terminal" : "";
  // Response-level truncation — whole earlier messages of the turn dropped by the byte budget — is
  // shown only in the reader's chrome bar, which is outside the exported Markdown and outside the
  // #response-body clone that Print current prints. Without this note a cut turn reads as complete.
  const DROP_NOTE = "… earlier messages in this turn were dropped, see terminal";
  const dropNote = flag => flag === true ? `\n\n    ${DROP_NOTE}` : "";
  const plainMarkdown = response => {
    // Fail closed: read the nonce into a local and require a non-empty string. Comparing against the
    // global directly would make a payload that omits `nonce` compare equal whenever it is unset.
    const nonce = window.ResponseViewerNonce;
    const header = response.prompt && response.prompt.text ? `**Prompt**\n\n${literalBlock(response.prompt.text)}${cutNote(response.prompt.truncated)}\n\n` : "";
    const body = response.markdown.replace(/```(pi-tool|pi-think)\n(.*)\n```/g, (whole, kind, json) => {
      if (typeof nonce !== "string" || !nonce) return whole;
      try {
        const payload = JSON.parse(json);
        if (payload.nonce !== nonce) return whole;
        if (kind === "pi-think") return `**Thinking**\n\n${literalBlock(payload.thinking)}${cutNote(payload.truncated)}`;
        const status = payload.status === "ok" ? "✓" : payload.status === "error" ? "✗" : "⏳";
        const result = payload.result ? `\n\n${literalBlock(payload.result)}${cutNote(payload.truncated)}` : "";
        return `**${status} ${inlineText(payload.name)}**\n\n${literalBlock(payload.summary)}${result}`;
      } catch { return whole; }
    });
    return `${header}${body}${dropNote(response.truncated)}`;
  };
  const create = ({ getSnapshot, getSelected, getCurrentBody, copy, render }) => {
    let printTimer = 0;
    const selected = () => getSnapshot()?.responses?.find(response => response.id === getSelected()) || null;
    const download = (text, name) => { const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" })), link = document.createElement("a"); link.href = url; link.download = `${filename(name)}.md`; link.hidden = true; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    const allMarkdown = () => (getSnapshot()?.responses || []).map((response, index) => `<!-- Response ${index + 1} -->\n\n${plainMarkdown(response)}`).join("\n\n---\n\n");
    const clearPrint = () => { const surface = document.getElementById("print-surface"); if (printTimer) { clearTimeout(printTimer); printTimer = 0; } surface?.replaceChildren(); surface?.setAttribute("aria-hidden", "true"); delete document.body.dataset.printScope; };
    addEventListener("afterprint", clearPrint);
    const print = all => {
      const responses = all ? getSnapshot()?.responses || [] : [selected()].filter(Boolean), surface = document.getElementById("print-surface");
      if (!responses.length || !surface) return;
      clearPrint();
      if (all) responses.forEach((response, index) => {
        const article = document.createElement("article"); article.className = "print-response article-body"; article.innerHTML = render(plainMarkdown(response));
        if (index) article.classList.add("print-break"); surface.append(article);
      });
      else {
        const current = getCurrentBody()?.cloneNode(true); if (!current) return;
        current.removeAttribute("id"); current.classList.add("print-response", "article-body");
        // Search highlights are reader-only navigation chrome and must not affect a printed response.
        for (const mark of current.querySelectorAll("mark.response-search-match")) mark.replaceWith(document.createTextNode(mark.textContent || ""));
        // The clone is #response-body; the "· Response truncated" marker lives in #response-meta.
        if (responses[0]?.truncated === true) { const note = document.createElement("p"); note.className = "print-drop-note"; note.textContent = DROP_NOTE; current.append(note); }
        surface.append(current);
      }
      surface.removeAttribute("aria-hidden");
      document.body.dataset.printScope = all ? "all" : "current";
      printTimer = setTimeout(clearPrint, 30_000);
      window.print();
    };
    return {
      copyCurrent(button) { const response = selected(); if (response) copy(plainMarkdown(response), button); },
      downloadCurrent() { const response = selected(); if (response) { const text = plainMarkdown(response); download(text, text.split(/\r?\n/).find(line => /^#{1,6}\s+/.test(line))?.replace(/^#{1,6}\s+/, "") || "response"); } },
      downloadAll() { const text = allMarkdown(); if (text) download(text, "pi-response-history"); },
      printCurrent() { print(false); }, printAll() { print(true); },
      destroy() { removeEventListener("afterprint", clearPrint); clearPrint(); },
    };
  };
  window.ResponseViewerExport = { create, filename };
})();
