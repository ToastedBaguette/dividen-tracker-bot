import { parseAmount, parseDate } from "./dividends.js";

const BASE_URL = "https://www.new.sahamidx.com/?/deviden";
const USER_AGENT = "Mozilla/5.0 (compatible; dividen-tracker-bot/1.0; personal use)";
const TIMEOUT_MS = 20_000;
// Page 1 holds ~50 rows (about three months); upcoming dividends never need more than a few pages
const MAX_PAGES = 5;

// Cells are matched by their data-header attribute, not by position: the site's header row lists
// "Payment Date" before "Recording Date" while the cells come the other way round.
const CELL_FIELDS = {
  Nama: "ticker",
  Amount: "amount",
  "Cum Date": "cumDate",
  "Ex Date": "exDate",
  "Recording Date": "recordingDate",
  "Payment Date": "paymentDate",
};

function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * Rows of one dividend page. Throws when the table is missing or no row is readable, i.e. the
 * site layout changed. Single odd rows (non-stock instruments, typos) are skipped.
 */
export function parseDividendPage(html) {
  const table = html.match(/<table[^>]*>[\s\S]*?Cum Date[\s\S]*?<\/table>/i);
  if (!table) throw new Error("SahamIDX: tabel dividen tidak ditemukan (layout situs berubah?)");

  const records = [];
  let skipped = 0;
  for (const rowHtml of table[0].split(/<tr[\s>]/i).slice(1)) {
    const cells = {};
    for (const m of rowHtml.matchAll(/<td[^>]*data-header="([^"]+)"[^>]*>([\s\S]*?)<\/td>/gi)) {
      const field = CELL_FIELDS[m[1].trim()];
      if (field) cells[field] = stripTags(m[2]);
    }
    if (!cells.ticker) continue; // header row

    const record = {
      ticker: cells.ticker.toUpperCase(),
      amount: parseAmount(cells.amount),
      cumDate: parseDate(cells.cumDate),
      exDate: parseDate(cells.exDate),
      recordingDate: parseDate(cells.recordingDate),
      paymentDate: parseDate(cells.paymentDate),
      source: "SahamIDX",
    };
    if (!/^[A-Z]{4}$/.test(record.ticker) || !record.cumDate) {
      skipped++;
      continue;
    }
    records.push(record);
  }

  if (records.length === 0 && skipped > 0) {
    throw new Error(`SahamIDX: ${skipped} baris tidak terbaca (format tanggal/kode berubah?)`);
  }
  if (skipped > 0) console.warn(`SahamIDX: skipped ${skipped} unreadable row(s)`);
  return records;
}

async function fetchPage(page, fetchImpl) {
  const url = page === 1 ? BASE_URL : `${BASE_URL}/page/${page}`;
  const res = await fetchImpl(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`SahamIDX: HTTP ${res.status}`);
  return res.text();
}

/**
 * Newest dividends, newest cum date first. Reads pages until they reach dates before `today`,
 * so the result always covers every upcoming dividend plus some recent ones.
 */
export async function fetchDividends(today, { fetchImpl = fetch } = {}) {
  const records = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = parseDividendPage(await fetchPage(page, fetchImpl));
    records.push(...rows);
    if (rows.length === 0 || rows.some((r) => r.cumDate < today)) break;
  }
  return records;
}

export const sahamIdxProvider = { name: "SahamIDX", fetch: fetchDividends };
