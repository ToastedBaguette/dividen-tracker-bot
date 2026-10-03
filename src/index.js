import { Client, Events, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
import { addDays, dateOf, firstBuyableDate, isDigestDay, normalizeTicker, nowParts, upcoming } from "./dividends.js";
import {
  DIGEST_TITLE,
  digestEmbed,
  healthAlertEmbed,
  helpEmbed,
  noDataEmbed,
  statusEmbed,
  tickerEmbed,
  unknownTickerEmbed,
  upcomingEmbed,
} from "./embeds.js";
import { createFeed } from "./feed.js";
import { buildProviders } from "./providers.js";
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
// "dividen BBRI", "div bbri"
const TICKER_COMMAND = /^(?:dividen|dividend|div)\s+([a-z]{4}(?:\.jk)?)$/;

const SCHEDULER_INTERVAL_MS = 60 * 1000;

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
 * Digest of cum dates still buyable within the next digestDays days, always from freshly fetched data
 */
async function buildDigest(now) {
  await feed.refresh();
  const status = feed.status();
  if (!status.fetchedAt) return noDataEmbed(status);

  const today = now.date;
  const records = upcoming(status.records, firstBuyableDate(now), { until: addDays(today, digestDays) });
  const quotes = await getQuotes(records.map((r) => r.ticker));
  return digestEmbed({ records, quotes, today, days: digestDays, status });
}

async function buildUpcoming(now) {
  const status = await feed.get();
  if (!status.fetchedAt) return noDataEmbed(status);

  const today = now.date;
  const records = upcoming(status.records, firstBuyableDate(now));
  const quotes = await getQuotes(records.map((r) => r.ticker));
  return upcomingEmbed({ records, quotes, today, status });
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
  return tickerEmbed({ ticker, upcoming: rows, history, quote: history?.quote, today, status });
}

/**
 * The daily digest already in the channel today — after a restart, don't post it twice
 */
async function digestPostedToday(channel, today) {
  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  return Boolean(
    recent?.some(
      (m) =>
        m.author.id === client.user.id &&
        dateOf(m.createdTimestamp) === today &&
        m.embeds[0]?.title?.startsWith(DIGEST_TITLE)
    )
  );
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
    build = async () => statusEmbed(await feed.get(), firstBuyableDate(now));
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
    await message.reply("❌ Gagal mengambil data dividen. Coba lagi sebentar lagi.").catch(() => {});
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
