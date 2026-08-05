/* Bounded unified-diff renderer. All assistant text is inserted as text nodes. */
(() => {
  const MAX_LINES = 3000, MAX_LINE = 12000;
  const hunk = line => {
    const match = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    return match && { old: Number(match[1] ?? 1), next: Number(match[2] ?? 1) };
  };
  const parse = source => {
    const lines = source.split(/\r?\n/);
    if (!source || lines.length > MAX_LINES || lines.some(line => line.length > MAX_LINE)) return null;
    let files = 0, section;
    const validSection = value => !!value && value.old && value.next && value.hunks > 0 && !value.hunk;
    const startSection = () => ({ old: false, next: false, hunks: 0, hunk: null });
    const finishOrStart = () => {
      if (!section) { section = startSection(); return true; }
      if (!section.old && !section.next && !section.hunks) return true;
      if (!validSection(section)) return false;
      section = startSection();
      return true;
    };
    const kinds = [];
    for (const line of lines) {
      let kind = "context";
      if (section?.hunk) {
        const active = section.hunk;
        if (/^\\ No newline at end of file$/.test(line)) kind = "meta";
        else if (line.startsWith("-")) { if (!active.old) return null; active.old -= 1; kind = "deletion"; }
        else if (line.startsWith("+")) { if (!active.next) return null; active.next -= 1; kind = "addition"; }
        else if (line.startsWith(" ")) { if (!active.old || !active.next) return null; active.old -= 1; active.next -= 1; }
        else return null;
        if (!active.old && !active.next) section.hunk = null;
      } else if (/^diff --git /.test(line)) {
        if (section && !validSection(section)) return null;
        section = startSection(); kind = "file";
      } else if (/^--- /.test(line)) {
        if (!finishOrStart() || section.old || section.next) return null;
        section.old = true; files += 1; kind = "old";
      } else if (/^\+\+\+ /.test(line)) {
        if (!section?.old || section.next) return null;
        section.next = true; kind = "new";
      } else {
        const parsed = hunk(line);
        if (parsed) {
          if (!section?.next) return null;
          section.hunks += 1; section.hunk = parsed.old || parsed.next ? parsed : null; kind = "hunk";
        } else if (/^(index |new file mode |deleted file mode |similarity index |rename (from|to) )/.test(line)) kind = "meta";
      }
      kinds.push(kind);
    }
    return files && validSection(section) ? kinds : null;
  };
  const build = ({ source }) => {
    const kinds = parse(source); if (!kinds) return null;
    const view = document.createElement("div"); view.className = "diff-view";
    source.split(/\r?\n/).forEach((line, index) => { const row = document.createElement("div"); row.className = `diff-line diff-${kinds[index]}`; row.textContent = line || " "; view.append(row); });
    return { nodes: [view] };
  };
  window.ResponseViewerDiff = { parse, build };
  window.ResponseViewerFences.register("diff", build);
})();
