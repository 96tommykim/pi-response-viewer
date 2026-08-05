/* First-party Markdown renderer for the response-viewer page. */
(() => {
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
  const metadata = value => {
    const info = String(value || "").slice(0, 512), match = /^([^\s]+)(?:\s+(.*))?$/.exec(info.trim());
    const language = match?.[1]?.toLowerCase().replace(/[^a-z0-9_-]/g, "") || "";
    const rest = match?.[2] || "", named = /(?:^|\s)(?:title|filename)="([^"\x00-\x1f]{1,160})"(?:\s|$)/.exec(rest);
    return { language, title: named ? named[1] : "" };
  };
  const markedRenderer = new marked.Renderer();
  markedRenderer.html = token => escape(typeof token === "string" ? token : token.raw || "");
  markedRenderer.code = token => {
    const text = typeof token === "string" ? token : token.text || "", source = text.replace(/\n$/, "") + "\n", info = metadata(typeof token === "string" ? "" : token.lang);
    const title = info.title ? ` title="${escape(info.title)}"` : "";
    return `<pre><code class="language-${escape(info.language)}"${title}>${escape(source)}</code></pre>\n`;
  };
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
  window.ResponseViewerRenderer = { render, metadata };
})();
