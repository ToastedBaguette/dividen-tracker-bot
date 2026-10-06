const TIME_ZONE = "Asia/Jakarta";
const DAY_MS = 24 * 60 * 60 * 1000;
// IDX regular market closes 15:50 and pre-closing ends 16:00 WIB; after that today's cum date can't be bought
const MARKET_CLOSE = "16:00";
// IDX trades in lots of 100 shares
const LOT_SIZE = 100;

// SahamIDX publishes English month abbreviations; Indonesian ones are accepted in case that changes
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, mei: 5, jun: 6, jul: 7,
  aug: 8, agu: 8, agt: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, des: 12,
};

const DAY_NAMES = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

/**
 * "08-Oct-2026" -> "2026-10-08"; null when unparseable
 */
export function parseDate(text) {
  const m = String(text ?? "").trim().match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  const day = Number(m[1]);
  if (!month || day < 1 || day > 31) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * "611.93" -> 611.93, "1,234.5" -> 1234.5; null when unparseable
 */
export function parseAmount(text) {
  const n = Number(String(text ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Date and time in Jakarta, independent of the host clock's zone
 */
export function nowParts(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/**
 * Jakarta calendar date of a timestamp (ms)
 */
export function dateOf(timestampMs) {
  return nowParts(new Date(timestampMs)).date;
}

function utcMidnight(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(isoDate, days) {
  return new Date(utcMidnight(isoDate) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / DAY_MS);
}

export function weekday(isoDate) {
  return new Date(utcMidnight(isoDate)).getUTCDay();
}

/**
 * "2026-10-08" -> "Kam, 08 Okt"
 */
export function formatDateId(isoDate, { year = false } = {}) {
  const [y, m, d] = isoDate.split("-");
  return `${DAY_NAMES[weekday(isoDate)]}, ${d} ${MONTH_NAMES[Number(m) - 1]}${year ? ` ${y}` : ""}`;
}

/**
 * "2026-10-26" -> "26 Okt"
 */
export function formatShortDate(isoDate) {
  if (!isoDate) return "?";
  const [, m, d] = isoDate.split("-");
  return `${d} ${MONTH_NAMES[Number(m) - 1]}`;
}

/**
 * "hari ini", "besok", "5 hari lagi"
 */
export function relativeDay(isoDate, today) {
  const days = daysBetween(today, isoDate);
  if (days === 0) return "hari ini";
  if (days === 1) return "besok";
  if (days < 0) return `${-days} hari lalu`;
  return `${days} hari lagi`;
}

/**
 * First cum date that can still be bought: today until market close, tomorrow after it
 */
export function firstBuyableDate({ date, time }) {
  return time >= MARKET_CLOSE ? addDays(date, 1) : date;
}

/**
 * Whether the digest posts on this date: only when its first buyable day is a trading weekday.
 * Evening digest (after close) → Sunday–Thursday; morning digest → Monday–Friday.
 */
export function isDigestDay(date, digestTime) {
  const day = weekday(firstBuyableDate({ date, time: digestTime }));
  return day !== 0 && day !== 6;
}

/**
 * Dividends still buyable: cum date from `from` (up to `until`, inclusive), nearest first
 */
export function upcoming(records, from, { until = "9999-12-31" } = {}) {
  return records
    .filter((r) => r.cumDate >= from && r.cumDate <= until)
    .sort((a, b) => a.cumDate.localeCompare(b.cumDate) || a.ticker.localeCompare(b.ticker));
}

/**
 * Dividends paid from `from` (up to `until`, inclusive), soonest payment first
 */
export function payments(records, from, { until = "9999-12-31" } = {}) {
  return records
    .filter((r) => r.paymentDate && r.paymentDate >= from && r.paymentDate <= until)
    .sort((a, b) => a.paymentDate.localeCompare(b.paymentDate) || a.ticker.localeCompare(b.ticker));
}

/**
 * [{ cumDate, records }] in input order
 */
export function groupByCumDate(records) {
  const groups = new Map();
  for (const r of records) {
    if (!groups.has(r.cumDate)) groups.set(r.cumDate, []);
    groups.get(r.cumDate).push(r);
  }
  return [...groups].map(([cumDate, rows]) => ({ cumDate, records: rows }));
}

/**
 * Percent, or null when the price is unknown
 */
export function dividendYield(amount, price) {
  if (!amount || !price) return null;
  return (amount / price) * 100;
}

/**
 * Rupiah paid on `lots` lots, or null when either is unknown
 */
export function dividendCash(amount, lots) {
  if (!amount || !lots) return null;
  return amount * lots * LOT_SIZE;
}

/**
 * "BBRI", "bbri", "BBRI.JK" -> "BBRI"; null for anything that is not an IDX ticker
 */
export function normalizeTicker(text) {
  const m = String(text ?? "").trim().toUpperCase().match(/^([A-Z]{4})(\.JK)?$/);
  return m ? m[1] : null;
}
