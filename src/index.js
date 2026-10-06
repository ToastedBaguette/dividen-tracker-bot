import { Client, Events, GatewayIntentBits, PermissionFlagsBits } from "discord.js";
import dotenv from "dotenv";
import { addDays, firstBuyableDate, isDigestDay, normalizeTicker, nowParts, payments, upcoming } from "./dividends.js";
import {
  digestEmbed,
  healthAlertEmbed,
  helpEmbed,
  isScheduledDigest,
  noDataEmbed,
  statusEmbed,
  tickerEmbed,
  unknownTickerEmbed,
  upcomingEmbed,
  watchlistEmbed,
  watchUsageEmbed,
} from "./embeds.js";
import { createFeed } from "./feed.js";
import { buildProviders } from "./providers.js";
import { applyWatchChange, createWatchlistStore, parseWatchArgs } from "./watchlist.js";
import { getDividendHistory, getQuotes } from "./yahoo.js";

dotenv.config();

const token = process.env.DISCORD_TOKEN;
const targetChannelId = process.env.DISCORD_CHANNEL_ID;
const authorizedUsers = (process.env.DISCORD_AUTHORIZED_USERS || "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const digestTime = /^\d{2}:\d{2}$/.test(process.env.DIGEST_TIME ?? "") ? process.env.DIGEST_TIME : "20:00";
const digestDays = Number(process.env.DIGEST_DAYS) > 0 ? Number(process.env.DIGEST_DAYS) : 7;

const HELP_COMMANDS = new Set(["bantuan", "help", "cara pakai"]);
const LIST_COMMANDS = new Set(["dividen", "dividend", "jadwal", "jadwal dividen", "semua"]);
const DIGEST_COMMANDS = new Set(["ringkasan", "digest", "hari ini", "today"]);
const STATUS_COMMANDS = new Set(["status"]);
const WATCHLIST_COMMANDS = new Set(["pantauan", "pantau", "watchlist"]);
// "dividen BBRI", "div bbri"
const TICKER_COMMAND = /^(?:dividen|dividend|div)\s+([a-z]{4}(?:\.jk)?)$/;
// "pantau BBRI 10 ASII", "lepas TLKM"
const WATCH_COMMAND = /^(pantau|watch|lepas|unwatch)\s+(.+)$/;
const UNWATCH_VERBS = new Set(["lepas", "unwatch"]);

const SCHEDULER_INTERVAL_MS = 60 * 1000;
// The digest's data may be this old: still fresh, and a retry after a failed post reuses it
// instead of scraping the source again every minute
const DIGEST_MAX_AGE_MS = 10 * 60 * 1000;

if (!token) {
  console.error("DISCORD_TOKEN is not set");
  process.exit(1);
}
if (!targetChannelId) {
  console.warn("DISCORD_CHANNEL_ID is not set — no daily digest or source alerts will be posted");
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const feed = createFeed({
  providers: buildProviders(),
  onHealthChange: async (health, previous, status) => {
    console.log(`Data source health: ${previous} -> ${health}`);
    const channel = await digestChannel();
    if (channel) await channel.send({ embeds: [healthAlertEmbed(health, previous, status)] });
  },
});

// Stored in a pinned message of the digest channel
const watchlist = createWatchlistStore({ channel: digestChannel, botId: () => client.user.id });

function isUserAuthorized(userId) {
  if (authorizedUsers.length === 0) return true;
  return authorizedUsers.includes(userId);
}

function isChannelAllowed(channelId) {
  if (!targetChannelId) return true;
  return targetChannelId === channelId;
}

async function digestChannel() {
  if (!targetChannelId) return null;
  try {
    return await client.channels.fetch(targetChannelId);
  } catch (err) {
    console.error(`Cannot open channel ${targetChannelId}:`, err.message);
    return null;
  }
}

/**
 * The watchlist, or an empty one when it can't be read — the digest and lists work without it
 */
async function currentWatchlist() {
  try {
    return await watchlist.get();
  } catch (err) {
    console.error("Watchlist unavailable:", err.message);
    return new Map();
  }
}

/**
 * Digest of cum dates still buyable within the next digestDays days, and of held stocks' payouts
 * in the same window, from data at most DIGEST_MAX_AGE_MS old
 */
async function buildDigest(now) {
  const status = await feed.get({ maxAgeMs: DIGEST_MAX_AGE_MS });
  if (!status.fetchedAt) return noDataEmbed(status);

  const today = now.date;
  const from = firstBuyableDate(now);
  const until = addDays(today, digestDays);
  const list = await currentWatchlist();
  const records = upcoming(status.records, from, { until });
  const paid = payments(status.records.filter((r) => list.get(r.ticker)), from, { until });
  const quotes = await getQuotes(records.map((r) => r.ticker));
  return digestEmbed({ records, paid, quotes, today, days: digestDays, status, watchlist: list });
}

async function buildUpcoming(now) {
  const status = await feed.get();
  if (!status.fetchedAt) return noDataEmbed(status);

  const today = now.date;
  const records = upcoming(status.records, firstBuyableDate(now));
  const quotes = await getQuotes(records.map((r) => r.ticker));
  return upcomingEmbed({ records, quotes, today, status, watchlist: await currentWatchlist() });
}

async function buildTicker(ticker, now) {
  const status = await feed.get();
  const today = now.date;
  const rows = upcoming(
    status.records.filter((r) => r.ticker === ticker),
    firstBuyableDate(now)
  );
  const history = await getDividendHistory(ticker);
  if (!rows.length && !history?.quote && !history?.dividends.length) return unknownTickerEmbed(ticker);
  const list = await currentWatchlist();
  return tickerEmbed({
    ticker,
    upcoming: rows,
    history,
    quote: history?.quote,
    today,
    status,
    watched: list.has(ticker),
    lots: list.get(ticker) ?? null,
  });
}

/**
 * The watchlist with its stocks' announced dividends and the coming payouts of held ones
 */
async function watchlistView(list, now, notes) {
  const status = await feed.get();
  const today = now.date;
  const records = upcoming(
    status.records.filter((r) => list.has(r.ticker)),
    firstBuyableDate(now)
  );
  const paid = payments(status.records.filter((r) => list.get(r.ticker)), today);
  const quotes = await getQuotes([...list.keys()]);
  const { pinned } = watchlist.status();
  return watchlistEmbed({ list, records, paid, quotes, today, status, notes, pinned });
}

async function buildWatchlist(now) {
  return watchlistView(await watchlist.get(), now, []);
}

/**
 * `pantau` / `lepas`: change the watchlist, save it to its pinned message, show the result
 */
async function buildWatch(action, entries, now) {
  const { list, lines } = await watchlist.update((current) => applyWatchChange(current, action, entries));
  console.log(`Watchlist ${action}: ${entries.map((e) => e.ticker).join(" ")} -> ${list.size} stocks`);
  return watchlistView(list, now, lines);
}

/**
 * The scheduled digest already in the channel today — after a restart, don't post it twice
 */
async function digestPostedToday(channel, today) {
  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  return Boolean(recent?.some((m) => isScheduledDigest(m, { botId: client.user.id, today })));
}

/**
 * Startup check: is there a pinned watchlist, and could the bot pin a new one?
 */
async function logWatchlist() {
  const channel = await digestChannel();
  if (!channel) return;
  const list = await currentWatchlist();
  const { loaded, pinned } = watchlist.status();
  if (loaded) console.log(`Watchlist: ${list.size} stocks (${pinned ? "pinned message" : "no message yet"})`);
  if (!pinned && !channel.permissionsFor?.(client.user)?.has(PermissionFlagsBits.PinMessages)) {
    console.warn("Watchlist: no Pin Messages permission in the channel — grant it, or pin the list message by hand");
  }
}

let lastDigestDate = null;
let digestRunning = false;

/**
 * Runs every minute: posts the digest once a day at or after digestTime, on days whose first
 * buyable cum date is a trading weekday
 */
async function digestTick() {
  const now = nowParts();
  const { date, time } = now;
  if (digestRunning || lastDigestDate === date || time < digestTime) return;
  if (!isDigestDay(date, digestTime)) {
    lastDigestDate = date;
    return;
  }

  const channel = await digestChannel();
  if (!channel) return;

  digestRunning = true;
  try {
    if (!(await digestPostedToday(channel, date))) {
      await channel.send({ embeds: [await buildDigest(now)] });
      console.log(`Daily digest posted for ${date}`);
    }
    lastDigestDate = date;
  } catch (err) {
    // lastDigestDate stays unset, so the next tick retries
    console.error("Daily digest failed:", err);
  } finally {
    digestRunning = false;
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`Digest: ${digestTime} WIB before each trading day, next ${digestDays} days`);
  await feed.refresh();
  const status = feed.status();
  console.log(`Data: ${status.records.length} rows from ${status.source ?? "nowhere"} (${status.health})`);
  await logWatchlist();

  digestTick();
  setInterval(digestTick, SCHEDULER_INTERVAL_MS);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!isChannelAllowed(message.channelId)) return;
  if (!isUserAuthorized(message.author.id)) return;

  const raw = message.content.trim().replace(/^[/!]/, "").replace(/\s+/g, " ");
  const text = raw.toLowerCase();
  const now = nowParts();

  let build = null;
  if (HELP_COMMANDS.has(text)) {
    build = async () => helpEmbed({ digestTime, digestDays });
  } else if (LIST_COMMANDS.has(text)) {
    build = () => buildUpcoming(now);
  } else if (DIGEST_COMMANDS.has(text)) {
    build = () => buildDigest(now);
  } else if (STATUS_COMMANDS.has(text)) {
    build = async () => statusEmbed(await feed.get(), firstBuyableDate(now), watchlist.status());
  } else if (WATCHLIST_COMMANDS.has(text)) {
    build = () => buildWatchlist(now);
  } else if (WATCH_COMMAND.test(text)) {
    const [, verb, args] = text.match(WATCH_COMMAND);
    const entries = parseWatchArgs(args);
    build = entries
      ? () => buildWatch(UNWATCH_VERBS.has(verb) ? "remove" : "add", entries, now)
      : async () => watchUsageEmbed();
  } else {
    // "dividen BBRI", or a bare ticker typed in capitals ("BBRI") so ordinary words like "halo" are ignored
    const ticker = normalizeTicker(text.match(TICKER_COMMAND)?.[1] ?? (/^[A-Z]{4}$/.test(raw) ? raw : null));
    if (ticker) build = () => buildTicker(ticker, now);
  }
  if (!build) return;

  try {
    await message.channel.sendTyping();
    await message.reply({ embeds: [await build()] });
  } catch (err) {
    console.error(`Command "${text}" failed:`, err);
    const watchCommand = WATCHLIST_COMMANDS.has(text) || WATCH_COMMAND.test(text);
    const reply = watchCommand
      ? `❌ Daftar pantauan gagal dibaca atau disimpan: ${err.message}`
      : "❌ Gagal mengambil data dividen. Coba lagi sebentar lagi.";
    await message.reply(reply).catch(() => {});
  }
});

process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    console.log(`${signal} received, shutting down`);
    await client.destroy();
    process.exit(0);
  });
}

client.login(token).catch((err) => {
  console.error("Discord login failed:", err.message);
  process.exit(1);
});
