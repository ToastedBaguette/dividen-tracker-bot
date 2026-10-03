import { dateOf } from "./dividends.js";

// Unofficial Yahoo Finance chart endpoint: no key, IDX tickers carry the ".JK" suffix
const BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const USER_AGENT = "Mozilla/5.0 (compatible; dividen-tracker-bot/1.0; personal use)";
const TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CONCURRENCY = 4;

const cache = new Map();

async function chart(ticker, query) {
  const key = `${ticker}?${query}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const res = await fetch(`${BASE_URL}/${ticker}.JK?${query}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Yahoo: HTTP ${res.status}`);

  const value = (await res.json())?.chart?.result?.[0] ?? null;
  cache.set(key, { at: Date.now(), value });
  return value;
}

function quoteFrom(result) {
  const meta = result?.meta;
  if (!meta?.regularMarketPrice) return null;
  return { price: meta.regularMarketPrice, name: meta.longName || meta.shortName || null };
}

/**
 * Last price and company name; null when Yahoo has nothing or is unreachable
 */
export async function getQuote(ticker) {
  try {
    return quoteFrom(await chart(ticker, "range=1d&interval=1d"));
  } catch (err) {
    console.error(`Yahoo quote ${ticker} failed:`, err.message);
    return null;
  }
}

/**
 * Map of ticker -> quote (or null), at most CONCURRENCY requests at a time
 */
export async function getQuotes(tickers) {
  const unique = [...new Set(tickers)];
  const quotes = new Map();
  let next = 0;
  async function worker() {
    while (next < unique.length) {
      const ticker = unique[next++];
      quotes.set(ticker, await getQuote(ticker));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));
  return quotes;
}

/**
 * Quote plus paid dividends of the last 5 years, newest first: [{ exDate, amount }].
 * Yahoo only knows dividends once they go ex — announced ones come from the feed.
 */
export async function getDividendHistory(ticker) {
  try {
    const result = await chart(ticker, "range=5y&interval=1mo&events=div");
    if (!result) return null;
    const dividends = Object.values(result.events?.dividends ?? {})
      .map((d) => ({ exDate: dateOf(d.date * 1000), amount: d.amount }))
      .sort((a, b) => b.exDate.localeCompare(a.exDate));
    return { quote: quoteFrom(result), dividends };
  } catch (err) {
    console.error(`Yahoo history ${ticker} failed:`, err.message);
    return null;
  }
}
