/* First-party link policy shared by the response-viewer page and focused tests. */
(() => {
  const allowedHref = value => {
    if (typeof value !== "string") return null;
    if (value.startsWith("#")) return { href: value, external: false };
    if (!/^(?:https?:\/\/|mailto:)/i.test(value)) return null;
    try {
      const url = new URL(value);
      return /^(https?:|mailto:)$/i.test(url.protocol) ? { href: value, external: true } : null;
    } catch { return null; }
  };
  window.ResponseViewerLinkPolicy = { allowedHref };
})();
