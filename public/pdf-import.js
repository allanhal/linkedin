// Reads a LinkedIn profile PDF ("More → Save to PDF", or a printed profile page) in the
// browser with pdf.js and returns its text plus best-guess name/headline/location.
// The file never leaves the browser; only the extracted text is sent for analysis.
import * as pdfjs from "/vendor/pdfjs/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";

const NOISE = /^(Page \d+ of \d+|Contact|www\.linkedin\.com\/in\/\S*|\(LinkedIn\)|Messaging|Show all.*|… more|\.\.\. more)$/i;

/**
 * LinkedIn's export has a narrow sidebar (Contact, Top Skills, Languages…) beside the main
 * column. Finds a vertical gutter in the left half that no text crosses; null if single-column.
 */
function findGutter(items, width) {
  let run = null;
  for (let g = width * 0.15; g <= width * 0.5; g += 2) {
    const crosses = items.some((it) => it.x < g && it.x + it.w > g);
    const left = items.filter((it) => it.x + it.w <= g).length;
    if (!crosses && left >= 3 && items.length - left >= 3) run = run ? { ...run, end: g } : { start: g, end: g };
    else if (run && run.end - run.start >= 10) break;
    else run = null;
  }
  return run && run.end - run.start >= 10 ? (run.start + run.end) / 2 : null;
}

/** Groups text items into visual lines (same baseline) per column, keeping font sizes. */
async function pageLines(page) {
  const { width } = page.getViewport({ scale: 1 });
  const { items: raw } = await page.getTextContent();
  const items = raw
    .filter((it) => it.str.trim())
    .map((it) => ({ text: it.str.trim(), x: it.transform[4], y: it.transform[5], w: it.width || 0, size: Math.abs(it.transform[3]) || it.height || 0 }));
  const gutter = findGutter(items, width);
  const columns = gutter == null ? [items] : [items.filter((it) => it.x < gutter), items.filter((it) => it.x >= gutter)];

  const toRows = (col) => {
    const rows = [];
    for (const it of col) {
      let row = rows.find((r) => Math.abs(r.y - it.y) < Math.max(2, it.size * 0.4));
      if (!row) rows.push((row = { y: it.y, size: it.size, parts: [] }));
      row.parts.push(it);
      row.size = Math.max(row.size, it.size);
    }
    return rows
      .sort((a, b) => b.y - a.y) // top to bottom
      .map((r) => ({ size: r.size, text: r.parts.sort((a, b) => a.x - b.x).map((p) => p.text).join(" ").replace(/\s+/g, " ") }));
  };
  if (columns.length === 1) return { main: toRows(columns[0]), side: [] };
  // the sidebar is the narrower, left column; the main column holds the name and experience
  const [left, right] = columns.map(toRows);
  return { main: right, side: left };
}

export async function readProfilePdf(file) {
  if (file.size > 25 * 1024 * 1024) throw new Error("PDF is larger than 25 MB");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  // main column of every page first (so experience reads continuously across pages), sidebars last
  const main = [];
  const side = [];
  for (let i = 1; i <= Math.min(doc.numPages, 15); i++) {
    const cols = await pageLines(await doc.getPage(i));
    main.push(...cols.main.map((l) => ({ ...l, page: i })));
    side.push(...cols.side.map((l) => ({ ...l, page: i })));
  }
  const lines = [...main, ...side];
  await doc.destroy();

  const kept = lines.filter((l) => !NOISE.test(l.text));
  const text = kept.map((l) => l.text).join("\n");
  if (text.replace(/\s/g, "").length < 40) {
    throw new Error("No text found in this PDF. If it's a scanned image, use LinkedIn's More → Save to PDF instead.");
  }

  // The name is the largest text on the first page; the headline and location follow it.
  const first = kept.filter((l) => l.page === 1 && l.text.length <= 80 && /\p{L}/u.test(l.text));
  const nameLine = first.reduce((best, l) => (!best || l.size > best.size ? l : best), null);
  const idx = kept.indexOf(nameLine);
  const after = kept.slice(idx + 1, idx + 4).filter((l) => l.size < nameLine.size);
  return {
    text,
    name: nameLine?.text || "",
    headline: after[0]?.text || "",
    location: after[1] && after[1].text.length < 80 ? after[1].text : "",
    pages: doc.numPages,
  };
}
