/* Explicit, local-only copy/download/print actions over the current bounded snapshot. */
(() => {
  const filename = value => (String(value || "response").replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "response");
  const create = ({ getSnapshot, getSelected, getCurrentBody, copy, render }) => {
    let printTimer = 0;
    const selected = () => getSnapshot()?.responses?.find(response => response.id === getSelected()) || null;
    const download = (text, name) => { const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" })), link = document.createElement("a"); link.href = url; link.download = `${filename(name)}.md`; link.hidden = true; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    const allMarkdown = () => (getSnapshot()?.responses || []).map((response, index) => `<!-- Response ${index + 1} -->\n\n${response.markdown}`).join("\n\n---\n\n");
    const clearPrint = () => { const surface = document.getElementById("print-surface"); if (printTimer) { clearTimeout(printTimer); printTimer = 0; } surface?.replaceChildren(); surface?.setAttribute("aria-hidden", "true"); delete document.body.dataset.printScope; };
    addEventListener("afterprint", clearPrint);
    const print = all => {
      const responses = all ? getSnapshot()?.responses || [] : [selected()].filter(Boolean), surface = document.getElementById("print-surface");
      if (!responses.length || !surface) return;
      clearPrint();
      if (all) responses.forEach((response, index) => {
        const article = document.createElement("article"); article.className = "print-response article-body"; article.innerHTML = render(response.markdown);
        if (index) article.classList.add("print-break"); surface.append(article);
      });
      else {
        const current = getCurrentBody()?.cloneNode(true); if (!current) return;
        current.removeAttribute("id"); current.classList.add("print-response", "article-body"); surface.append(current);
      }
      surface.removeAttribute("aria-hidden");
      document.body.dataset.printScope = all ? "all" : "current";
      printTimer = setTimeout(clearPrint, 30_000);
      window.print();
    };
    return {
      copyCurrent(button) { const response = selected(); if (response) copy(response.markdown, button); },
      downloadCurrent() { const response = selected(); if (response) download(response.markdown, response.markdown.split(/\r?\n/).find(line => /^#{1,6}\s+/.test(line))?.replace(/^#{1,6}\s+/, "") || "response"); },
      downloadAll() { const text = allMarkdown(); if (text) download(text, "pi-response-history"); },
      printCurrent() { print(false); }, printAll() { print(true); },
      destroy() { removeEventListener("afterprint", clearPrint); clearPrint(); },
    };
  };
  window.ResponseViewerExport = { create, filename };
})();
