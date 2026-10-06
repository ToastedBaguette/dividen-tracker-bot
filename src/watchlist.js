import { RESTJSONErrorCodes } from "discord.js";
import { normalizeTicker } from "./dividends.js";
import { WATCHLIST_TITLE, fmt, watchlistStateEmbed } from "./embeds.js";

// Keeps the list and every view of it within one embed
export const MAX_WATCHLIST = 50;

// "10", "1.000" (Indonesian thousands separator)
const LOTS = /^\d+(?:\.\d{3})*$/;
// "BBRI · 10 lot" or "TLKM" — one line of the pinned message
const STATE_LINE = /^([A-Z]{4})(?: · (\d+) lot)?$/;

/**
 * "bbri 10 asii 5 lot tlkm" -> [{ ticker: "BBRI", lots: 10 }, { ticker: "ASII", lots: 5 }, { ticker: "TLKM" }]
 * (lots left out when not given); null when a word is not a ticker, a lot count after a ticker, or "lot"
 */
export function parseWatchArgs(text) {
  const entries = [];
  for (const word of String(text ?? "").trim().split(/\s+/)) {
    const ticker = normalizeTicker(word);
    const last = entries.at(-1);
    if (ticker) {
      entries.push({ ticker });
    } else if (last && last.lots === undefined && LOTS.test(word)) {
      last.lots = Number(word.replace(/\./g, ""));
    } else if (last?.lots === undefined || word.toLowerCase() !== "lot") {
      return null; // "lot" may only follow a count
    }
  }
  return entries.length ? entries : null;
}

/**
 * The list after `pantau` ("add": add, or set lots — 0 clears them, none keeps them) or `lepas`
 * ("remove"), with one line per entry saying what happened. Lists map ticker -> lots or null.
 */
export function applyWatchChange(list, action, entries) {
  const next = new Map(list);
  const lines = [];
  for (const { ticker, lots } of entries) {
    if (action === "remove") {
      lines.push(next.delete(ticker) ? `🗑️ **${ticker}** dilepas` : `ℹ️ **${ticker}** tidak ada di pantauan`);
    } else if (!next.has(ticker) && next.size >= MAX_WATCHLIST) {
      lines.push(`⚠️ **${ticker}** tidak ditambahkan — maksimal ${MAX_WATCHLIST} saham`);
    } else {
      const held = lots === undefined ? (next.get(ticker) ?? null) : lots || null;
      next.set(ticker, held);
      lines.push(`⭐ **${ticker}** dipantau${held ? ` · ${fmt(held)} lot` : ""}`);
    }
  }
  return { list: next, lines };
}

/**
 * The pinned message's text: "BBRI · 10 lot" or "TLKM" per line, alphabetical
 */
export function formatWatchlist(list) {
  return [...list]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ticker, lots]) => (lots ? `${ticker} · ${lots} lot` : ticker))
    .join("\n");
}

export function parseWatchlist(text) {
  const list = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const m = line.trim().match(STATE_LINE);
    if (m) list.set(m[1], m[2] ? Number(m[2]) : null);
  }
  return list;
}

/**
 * The watchlist, stored in one pinned bot message of the channel — no database, no volume.
 * Read from the channel's pins once, then kept in memory; every change edits that message.
 *
 * `channel` resolves to the channel (or null when none is configured); `botId` returns the bot's
 * user id. pinned is null until a watchlist message exists.
 */
export function createWatchlistStore({ channel: getChannel, botId }) {
  let list = null;
  let message = null;
  let pinned = null;
  let loading = null;
  let queue = Promise.resolve();

  async function channel() {
    const found = await getChannel();
    if (!found) throw new Error("DISCORD_CHANNEL_ID belum diatur");
    return found;
  }

  async function load() {
    const c = await channel();
    let before;
    for (;;) {
      const page = await c.messages.fetchPins(before ? { before } : {});
      const hit = page.items.find(
        ({ message: m }) => m.author.id === botId() && m.embeds[0]?.title === WATCHLIST_TITLE
      );
      if (hit) {
        message = hit.message;
        pinned = true;
        return parseWatchlist(message.embeds[0].description);
      }
      if (!page.hasMore || page.items.length === 0) return new Map();
      before = page.items.at(-1).pinnedTimestamp;
    }
  }

  /**
   * The list (ticker -> lots or null); throws when the channel or its pins can't be read
   */
  async function get() {
    if (list) return list;
    loading ??= load().finally(() => {
      loading = null;
    });
    list = await loading;
    return list;
  }

  /**
   * Pins the message; false when the bot may not, unless someone pinned it by hand
   */
  async function pin(m) {
    try {
      await m.pin();
      return true;
    } catch (err) {
      console.error("Cannot pin the watchlist message:", err.message);
      return Boolean((await m.fetch().catch(() => null))?.pinned);
    }
  }

  async function save(next) {
    const payload = { embeds: [watchlistStateEmbed(formatWatchlist(next))] };
    if (message) {
      try {
        await message.edit(payload);
      } catch (err) {
        if (err.code !== RESTJSONErrorCodes.UnknownMessage) throw err;
        message = null; // deleted by hand: post a new one
      }
    }
    if (!message) {
      message = await (await channel()).send(payload);
      pinned = false;
    }
    if (!pinned) pinned = await pin(message);
  }

  /**
   * Applies change(list) -> { list, ...rest } and saves the new list, one change at a time so quick
   * successive commands don't overwrite each other. Resolves to { list, ...rest }.
   */
  function update(change) {
    const run = queue.then(async () => {
      const current = await get();
      const result = change(current);
      if (formatWatchlist(result.list) !== formatWatchlist(current)) {
        await save(result.list);
        list = result.list;
      }
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  function status() {
    return { loaded: list !== null, size: list?.size ?? 0, pinned };
  }

  return { get, update, status };
}
