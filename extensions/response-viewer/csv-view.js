/* Bounded RFC-4180-style CSV table with stable client-side sorting. */
(() => {
  const MAX_SOURCE = 256 * 1024, MAX_ROWS = 1000, MAX_COLUMNS = 80, MAX_CELLS = 12000, MAX_CELL = 8000;
  const parse = source => {
    if (!source || source.length > MAX_SOURCE) return null;
    const rows = []; let row = [], field = "", quoted = false, closedQuote = false;
    const pushField = () => { if (field.length > MAX_CELL) return false; row.push(field); field = ""; closedQuote = false; return true; };
    const pushRow = () => { if (!pushField()) return false; rows.push(row); row = []; return rows.length <= MAX_ROWS; };
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      if (quoted) { if (c === '"') { if (source[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closedQuote = true; } } else field += c; continue; }
      if (closedQuote) {
        if (c === ",") { if (!pushField()) return null; continue; }
        if (c === "\n" || c === "\r") { if (c === "\r" && source[i + 1] === "\n") i++; if (!pushRow()) return null; continue; }
        return null;
      }
      if (c === '"') { if (field) return null; quoted = true; }
      else if (c === ",") { if (!pushField()) return null; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && source[i + 1] === "\n") i++; if (!pushRow()) return null; }
      else field += c;
    }
    if (quoted || field.length > MAX_CELL) return null;
    if (field || row.length) { if (!pushRow()) return null; }
    while (rows.length && rows[0].every(value => value === "")) rows.shift();
    while (rows.length && rows.at(-1).every(value => value === "")) rows.pop();
    if (rows.length < 2 || rows[0].length < 1 || rows[0].length > MAX_COLUMNS || rows.length * rows[0].length > MAX_CELLS || rows.some(item => item.length !== rows[0].length)) return null;
    return rows;
  };
  const build = ({ source }) => {
    const rows = parse(source); if (!rows) return null;
    const view = document.createElement("div"), table = document.createElement("table"), thead = document.createElement("thead"), tbody = document.createElement("tbody");
    view.className = "csv-view table-wrap"; const heading = document.createElement("tr"); let direction = 1, active = -1;
    const renderRows = data => { tbody.replaceChildren(); data.forEach(({ row, index }) => { const tr = document.createElement("tr"); row.forEach(value => { const td = document.createElement("td"); td.textContent = value; tr.append(td); }); tr.dataset.sourceIndex = String(index); tbody.append(tr); }); };
    const sourceRows = rows.slice(1).map((row, index) => ({ row, index }));
    rows[0].forEach((name, column) => {
      const th = document.createElement("th"), button = document.createElement("button");
      th.scope = "col"; th.setAttribute("aria-sort", "none"); button.type = "button"; button.textContent = name || `Column ${column + 1}`;
      button.addEventListener("click", () => {
        direction = active === column ? -direction : 1; active = column;
        const ordered = sourceRows.slice().sort((a, b) => direction * a.row[column].localeCompare(b.row[column], undefined, { numeric: true, sensitivity: "base" }) || a.index - b.index);
        renderRows(ordered);
        heading.querySelectorAll("th").forEach((item, index) => item.setAttribute("aria-sort", index === column ? (direction === 1 ? "ascending" : "descending") : "none"));
      });
      th.append(button); heading.append(th);
    });
    thead.append(heading); renderRows(sourceRows); table.append(thead, tbody); view.append(table); return { nodes: [view] };
  };
  window.ResponseViewerCsv = { parse, build };
  window.ResponseViewerFences.register("csv", build);
})();
