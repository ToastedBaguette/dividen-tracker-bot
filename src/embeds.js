import { EmbedBuilder } from "discord.js";
import {
  addDays,
  dateOf,
  daysBetween,
  dividendCash,
  dividendYield,
  formatDateId,
  formatShortDate,
  groupByCumDate,
  relativeDay,
} from "./dividends.js";

const COLORS = {
  ok: 0x2ecc71,
  warn: 0xe67e22,
  danger: 0xe74c3c,
  info: 0x3498db,
  muted: 0x95a5a6,
};

// The scheduler recognizes an already-posted digest by this title prefix
export const DIGEST_TITLE = "📅 Dividen Terdekat";
// The watchlist store finds its pinned message by this title
export const WATCHLIST_TITLE = "📌 Daftar Pantauan";

// Discord limits, with headroom
const MAX_FIELDS = 25;
const MAX_FIELD_VALUE = 1000;
const MAX_EMBED_CHARS = 5500;

const NO_WATCHLIST = new Map();

/**
 * 1450 -> "1.450", 611.93 -> "611,93"
 */
export function fmt(n, maxDigits = 2) {
  return (Number(n) || 0).toLocaleString("id-ID", { maximumFractionDigits: maxDigits });
}

function fmtYield(pct) {
  if (pct === null) return null;
  return `${fmt(pct, pct < 0.1 ? 2 : 1)}%`;
}

function sourceFooter(status) {
  const parts = [`Sumber: ${status.source ?? "-"}`, "Harga: Yahoo Finance"];
  if (status.health === "fallback") parts.push("⚠️ sumber cadangan");
  if (status.health === "down") parts.push("⚠️ data lama — sumber gagal");
  return parts.join(" · ");
}

/**
 * "10 lot ≈ Rp98.000"; null without lots or amount
 */
function cashText(amount, lots) {
  const cash = dividendCash(amount, lots);
  return cash === null ? null : `${fmt(lots)} lot ≈ Rp${fmt(cash, 0)}`;
}

function recordLine(r, quotes, watchlist) {
  const parts = [`${watchlist.has(r.ticker) ? "⭐ " : ""}**${r.ticker}**`, r.amount ? `Rp${fmt(r.amount)}` : "Rp?"];
  const y = fmtYield(dividendYield(r.amount, quotes.get(r.ticker)?.price));
  if (y) parts.push(`yield ${y}`);
  parts.push(`bayar ${formatShortDate(r.paymentDate)}`);
  return parts.join(" · ");
}

/**
 * A watched stock's announced dividend with the cash for its lots, then its dates
 */
function watchedLine(r, quotes, lots, today) {
  const parts = [`**${r.ticker}**`, r.amount ? `Rp${fmt(r.amount)}` : "Rp?"];
  const y = fmtYield(dividendYield(r.amount, quotes.get(r.ticker)?.price));
  if (y) parts.push(`yield ${y}`);
  const cash = cashText(r.amount, lots);
  if (cash) parts.push(cash);
  return (
    `${parts.join(" · ")}\n` +
    `cum ${formatDateId(r.cumDate)} (${relativeDay(r.cumDate, today)}) · bayar ${formatShortDate(r.paymentDate)}`
  );
}

/**
 * A held stock's coming payout
 */
function payoutLine(r, lots, today) {
  const cash = cashText(r.amount, lots) ?? `${fmt(lots)} lot`;
  return `**${r.ticker}** · ${cash} · cair ${formatDateId(r.paymentDate)} (${relativeDay(r.paymentDate, today)})`;
}

function groupName(cumDate, today) {
  const days = daysBetween(today, cumDate);
  if (days === 0) return `⏰ Hari ini (${formatDateId(cumDate)}) — hari terakhir beli`;
  if (days === 1) return `⏰ Besok (${formatDateId(cumDate)}) — hari terakhir beli`;
  return `${formatDateId(cumDate)} · ${relativeDay(cumDate, today)}`;
}

/**
 * Lines joined up to the field limit, the rest summarized
 */
function fieldValue(lines) {
  const out = [];
  let length = 0;
  for (const [i, line] of lines.entries()) {
    const rest = lines.length - i;
    if (length + line.length + 20 > MAX_FIELD_VALUE) {
      out.push(`…dan ${rest} lagi`);
      break;
    }
    out.push(line);
    length += line.length + 1;
  }
  return out.join("\n");
}

/**
 * One field per cum date, within Discord's field-count and total-size limits
 */
function cumDateFields(records, quotes, today, { watchlist, baseLength, maxFields }) {
  const fields = [];
  let length = baseLength;
  const groups = groupByCumDate(records);
  for (const [i, group] of groups.entries()) {
    const field = {
      name: groupName(group.cumDate, today),
      value: fieldValue(group.records.map((r) => recordLine(r, quotes, watchlist))),
    };
    const size = field.name.length + field.value.length;
    if (fields.length === maxFields - 1 || length + size > MAX_EMBED_CHARS) {
      const left = groups.slice(i).reduce((n, g) => n + g.records.length, 0);
      fields.push({ name: "…", value: `dan ${left} saham lagi — ketik \`dividen KODE\` untuk detail` });
      break;
    }
    fields.push(field);
    length += size;
  }
  return fields;
}

/**
 * Daily digest: dividends whose cum date falls within the next `days` days. Watched stocks are
 * starred and repeated on top with the cash for their lots; `paid` holds the held stocks' payouts.
 */
export function digestEmbed({ records, quotes, today, days, status, watchlist = NO_WATCHLIST, paid = [] }) {
  const description = records.length
    ? `**${records.length} saham** cum date sampai ${formatDateId(addDays(today, days))}.\n` +
      "Beli paling lambat **pada cum date** (pasar reguler) untuk dapat dividen."
    : `Tidak ada cum date dalam ${days} hari ke depan.`;
  const embed = new EmbedBuilder()
    .setColor(records.length ? COLORS.info : COLORS.muted)
    .setTitle(`${DIGEST_TITLE} · ${formatDateId(today, { year: true })}`)
    .setDescription(description)
    .setFooter({ text: sourceFooter(status) });

  const top = [];
  const watched = records.filter((r) => watchlist.has(r.ticker));
  if (watched.length) {
    top.push({
      name: "⭐ Pantauan",
      value: fieldValue(watched.map((r) => watchedLine(r, quotes, watchlist.get(r.ticker), today))),
    });
  }
  if (paid.length) {
    top.push({
      name: "💰 Akan Cair · perkiraan",
      value: fieldValue(paid.map((r) => payoutLine(r, watchlist.get(r.ticker), today))),
    });
  }
  const baseLength = top.reduce((n, f) => n + f.name.length + f.value.length, description.length + 200);
  return embed.addFields(
    ...top,
    ...cumDateFields(records, quotes, today, { watchlist, baseLength, maxFields: MAX_FIELDS - top.length })
  );
}

/**
 * Whether a channel message is the scheduled digest of `today`. Replies to `ringkasan` carry the
 * same title but don't count: the scheduled post is never a reply.
 */
export function isScheduledDigest(message, { botId, today }) {
  return (
    message.author.id === botId &&
    !message.reference &&
    dateOf(message.createdTimestamp) === today &&
    Boolean(message.embeds[0]?.title?.startsWith(DIGEST_TITLE))
  );
}

/**
 * Every announced dividend that can still be bought
 */
export function upcomingEmbed({ records, quotes, today, status, watchlist = NO_WATCHLIST }) {
  const description = records.length
    ? `**${records.length} saham** sudah mengumumkan dividen yang masih bisa dikejar.`
    : "Belum ada dividen yang diumumkan dengan cum date hari ini atau setelahnya.";
  const embed = new EmbedBuilder()
    .setColor(records.length ? COLORS.info : COLORS.muted)
    .setTitle("📋 Semua Jadwal Dividen")
    .setDescription(description)
    .setFooter({ text: sourceFooter(status) });
  return embed.addFields(
    cumDateFields(records, quotes, today, { watchlist, baseLength: description.length + 200, maxFields: MAX_FIELDS })
  );
}

/**
 * One stock: announced dividends (with the cash for held lots), price, trailing yield, recent payouts
 */
export function tickerEmbed({ ticker, upcoming, history, quote, today, status, watched = false, lots = null }) {
  const price = quote?.price ?? history?.quote?.price ?? null;
  const name = quote?.name ?? history?.quote?.name ?? null;
  const label = `${watched ? "⭐ " : ""}${ticker}`;
  const embed = new EmbedBuilder()
    .setColor(upcoming.length ? COLORS.ok : COLORS.muted)
    .setTitle(name ? `${label} · ${name}` : label)
    .setFooter({ text: sourceFooter(status) });

  const upcomingLines = upcoming.map((r) => {
    const y = fmtYield(dividendYield(r.amount, price));
    const cash = cashText(r.amount, lots);
    return (
      `**Rp${fmt(r.amount)}**${y ? ` (yield ${y})` : ""}${cash ? ` · ${cash}` : ""}\n` +
      `cum **${formatDateId(r.cumDate)}** — ${relativeDay(r.cumDate, today)} · ` +
      `ex ${formatShortDate(r.exDate)} · bayar ${formatShortDate(r.paymentDate)}`
    );
  });
  embed.addFields({
    name: "Dividen yang Akan Datang",
    value: upcomingLines.length ? fieldValue(upcomingLines) : "Belum ada jadwal dividen yang diumumkan.",
  });

  if (price) {
    const yearAgo = addDays(today, -365);
    const trailing = (history?.dividends ?? []).filter((d) => d.exDate > yearAgo).reduce((n, d) => n + d.amount, 0);
    const y = fmtYield(dividendYield(trailing, price));
    embed.addFields(
      { name: "Harga Terakhir", value: `Rp${fmt(price)}`, inline: true },
      { name: "Dividen 12 Bulan", value: trailing ? `Rp${fmt(trailing)} (yield ${y})` : "-", inline: true }
    );
  }

  const paid = (history?.dividends ?? []).slice(0, 6);
  if (paid.length) {
    embed.addFields({
      name: "Riwayat (ex date)",
      value: paid.map((d) => `${formatDateId(d.exDate, { year: true })} · Rp${fmt(d.amount)}`).join("\n"),
    });
  }
  return embed;
}

export function unknownTickerEmbed(ticker) {
  return new EmbedBuilder()
    .setColor(COLORS.muted)
    .setTitle(`❓ ${ticker}`)
    .setDescription("Kode saham tidak dikenal, atau belum ada data dividennya.");
}

export function noDataEmbed(status) {
  const errors = status.errors.map((e) => `• ${e.provider}: ${e.message}`).join("\n");
  return new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle("🚨 Data dividen belum tersedia")
    .setDescription(`Semua sumber data gagal dan belum ada data tersimpan.\n${errors}`.slice(0, 4000));
}

/**
 * Posted to the channel when the data source breaks, falls back, or recovers
 */
export function healthAlertEmbed(health, previous, status) {
  const errors = status.errors.map((e) => `• **${e.provider}**: ${e.message}`).join("\n") || "-";
  if (health === "ok") {
    return new EmbedBuilder()
      .setColor(COLORS.ok)
      .setTitle("✅ Sumber data dividen pulih")
      .setDescription(`Data kembali diambil dari **${status.source}**.`);
  }
  if (health === "fallback") {
    return new EmbedBuilder()
      .setColor(COLORS.warn)
      .setTitle("⚠️ Sumber utama gagal — memakai sumber cadangan")
      .setDescription(`Data sekarang dari **${status.source}**.\n${errors}`.slice(0, 4000));
  }
  const last = status.fetchedAt
    ? `Bot tetap memakai data terakhir dari <t:${Math.floor(status.fetchedAt / 1000)}:R> (${status.source}).`
    : "Belum ada data tersimpan.";
  return new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle("🚨 Semua sumber data dividen gagal")
    .setDescription(`${errors}\n\n${last} Dicoba lagi otomatis.`.slice(0, 4000));
}

function watchlistStatus(watch) {
  if (!watch?.loaded) return "belum dimuat";
  const pin = watch.pinned ? "📌 tersemat" : watch.pinned === false ? "⚠️ belum tersemat" : "belum ada pesan";
  return `${watch.size} saham · ${pin}`;
}

export function statusEmbed(status, from, watch) {
  const healthText = { ok: "✅ normal", fallback: "⚠️ sumber cadangan", down: "🚨 semua sumber gagal" };
  const upcoming = status.records.filter((r) => r.cumDate >= from).length;
  const embed = new EmbedBuilder()
    .setColor(status.health === "ok" ? COLORS.ok : status.health === "fallback" ? COLORS.warn : COLORS.danger)
    .setTitle("🔧 Status Sumber Data")
    .addFields(
      { name: "Kondisi", value: healthText[status.health] ?? "belum dicek", inline: true },
      { name: "Sumber aktif", value: status.source ?? "-", inline: true },
      {
        name: "Diperbarui",
        value: status.fetchedAt ? `<t:${Math.floor(status.fetchedAt / 1000)}:R>` : "belum pernah",
        inline: true,
      },
      { name: "Data", value: `${status.records.length} baris · ${upcoming} akan datang`, inline: true },
      { name: "Urutan sumber", value: status.providers.join(" → "), inline: true },
      { name: "Pantauan", value: watchlistStatus(watch), inline: true }
    );
  if (status.errors.length) {
    embed.addFields({
      name: "Error terakhir",
      value: status.errors.map((e) => `• **${e.provider}**: ${e.message}`).join("\n").slice(0, 1000),
    });
  }
  return embed;
}

export function helpEmbed({ digestTime, digestDays }) {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle("📖 Cara Pakai Dividen Tracker")
    .setDescription(
      `Pukul **${digestTime} WIB** menjelang setiap hari bursa, bot mengirim daftar saham dengan cum date ` +
        `dalam **${digestDays} hari** ke depan, terdekat dulu.\n\n` +
        "**Cum date** = hari terakhir membeli saham (pasar reguler) agar tetap dapat dividen. " +
        "Beli di ex date atau setelahnya → tidak dapat. Setelah pasar tutup (16:00), cum date hari ini " +
        "sudah lewat dan tidak ditampilkan lagi.\n\n" +
        "Saham pantauan (⭐) tampil paling atas di ringkasan, dengan perkiraan dividen untuk lot yang " +
        "kamu pegang dan tanggal dananya cair."
    )
    .addFields(
      { name: "`dividen`", value: "Semua dividen yang masih bisa dikejar" },
      { name: "`dividen BBRI` atau `BBRI`", value: "Detail satu saham: jadwal, harga, yield, riwayat" },
      { name: "`ringkasan`", value: "Kirim ringkasan harian sekarang" },
      {
        name: "`pantau BBRI 10`",
        value: "Pantau saham; angka = lot yang kamu pegang (opsional). Beberapa sekaligus: `pantau BBRI 10 ASII`",
      },
      { name: "`lepas BBRI`", value: "Berhenti memantau" },
      { name: "`pantauan`", value: "Daftar pantauan: jadwal dividen dan perkiraan dana cair" },
      { name: "`status`", value: "Kondisi sumber data" },
      { name: "`bantuan`", value: "Panduan ini" }
    )
    .setFooter({ text: "Bukan rekomendasi investasi. Cek ulang di keterbukaan informasi IDX sebelum transaksi." });
}

/**
 * The watchlist: announced dividends of watched stocks, coming payouts of held ones, and the list
 * itself. `notes` (what a command changed) open the description; `pinned === false` adds a warning.
 */
export function watchlistEmbed({ list, records, paid, quotes, today, status, notes = [], pinned = null }) {
  const held = [...list.values()].filter(Boolean).length;
  const summary = list.size
    ? `**${list.size} saham** dipantau${held ? `, ${held} dengan lot` : ""}.`
    : "Belum ada saham dipantau. Tambahkan dengan `pantau BBRI`, atau `pantau BBRI 10` kalau kamu pegang 10 lot.";
  const parts = [notes.join("\n"), summary];
  if (pinned === false) {
    parts.push(
      `⚠️ Bot belum bisa menyematkan pesan **${WATCHLIST_TITLE}**. Beri bot izin *Pin Messages* di channel ini, ` +
        "atau sematkan pesan itu sekali secara manual — tanpa itu daftar ini hilang saat bot restart."
    );
  }
  const embed = new EmbedBuilder()
    .setColor(list.size ? COLORS.info : COLORS.muted)
    .setTitle("⭐ Pantauan Dividen")
    .setDescription(parts.filter(Boolean).join("\n\n").slice(0, 4000))
    .setFooter({ text: sourceFooter(status) });
  if (!list.size) return embed;

  embed.addFields({
    name: "Dividen yang Akan Datang",
    value: records.length
      ? fieldValue(records.map((r) => watchedLine(r, quotes, list.get(r.ticker), today)))
      : "Belum ada jadwal dividen yang diumumkan.",
  });
  if (paid.length) {
    embed.addFields({
      name: "💰 Akan Cair · perkiraan",
      value: fieldValue(paid.map((r) => payoutLine(r, list.get(r.ticker), today))),
    });
  }
  const entries = [...list].sort(([a], [b]) => a.localeCompare(b));
  return embed.addFields({
    name: `Daftar (${list.size})`,
    value: fieldValue(
      entries.map(
        ([ticker, lots]) =>
          `**${ticker}**${lots ? ` · ${fmt(lots)} lot` : ""} — ${quotes.get(ticker)?.name ?? "❓ tidak ditemukan di Yahoo"}`
      )
    ),
  });
}

export function watchUsageEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.muted)
    .setTitle("⭐ Cara Memantau Saham")
    .setDescription(
      "`pantau BBRI` — pantau saja\n" +
        "`pantau BBRI 10` — pantau, kamu pegang 10 lot\n" +
        "`pantau BBRI 10 ASII 5 TLKM` — beberapa sekaligus\n" +
        "`pantau BBRI 0` — hapus lot, tetap dipantau\n" +
        "`lepas BBRI` — berhenti memantau\n" +
        "`pantauan` — lihat daftar"
    );
}

/**
 * The pinned message the watchlist is stored in; `text` is formatWatchlist() output
 */
export function watchlistStateEmbed(text) {
  return new EmbedBuilder()
    .setColor(COLORS.muted)
    .setTitle(WATCHLIST_TITLE)
    .setDescription(text || "(kosong)")
    .setFooter({ text: "Bot menyimpan daftar pantauan di pesan ini — biarkan tersemat. Ubah dengan perintah pantau / lepas." });
}
