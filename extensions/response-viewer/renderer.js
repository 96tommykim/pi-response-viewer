/* First-party Markdown renderer for the response-viewer page. */
(() => {
  const escape = value => value.replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
  const markedRenderer = new marked.Renderer();
  markedRenderer.html = token => escape(typeof token === "string" ? token : token.raw || "");
  const allowedTags = ["a","blockquote","br","code","del","em","h1","h2","h3","h4","h5","h6","hr","li","ol","p","pre","strong","table","thead","tbody","tr","th","td","ul"];
  const allowedAttrs = ["href","title","align","class"];
  const render = markdown => {
    const parsed = marked.parse(typeof markdown === "string" ? markdown : "", { renderer: markedRenderer, gfm: true, breaks: false });
    const clean = DOMPurify.sanitize(parsed, { ALLOWED_TAGS: allowedTags, ALLOWED_ATTR: allowedAttrs, ALLOW_DATA_ATTR: false });
    const fragment = document.createElement("template");
    fragment.innerHTML = clean;
    fragment.content.querySelectorAll("a[href]").forEach(a => {
      const link = window.ResponseViewerLinkPolicy.allowedHref(a.getAttribute("href"));
      if (!link) { a.removeAttribute("href"); return; }
      if (link.external) { a.rel = "noreferrer noopener"; a.target = "_blank"; }
      else { a.removeAttribute("rel"); a.removeAttribute("target"); }
    });
    return fragment.innerHTML;
  };
  window.ResponseViewerRenderer = { render };
})();
