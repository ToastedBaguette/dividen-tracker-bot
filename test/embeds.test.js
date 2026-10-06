import { test } from "node:test";
import assert from "node:assert/strict";
import { DIGEST_TITLE, digestEmbed, fmt, isScheduledDigest, watchlistEmbed } from "../src/embeds.js";
import { addDays } from "../src/dividends.js";

const status = { source: "SahamIDX", health: "ok" };

test("fmt uses Indonesian separators", () => {
  assert.equal(fmt(1450), "1.450");
  assert.equal(fmt(611.93), "611,93");
  assert.equal(fmt(1.422181), "1,42");
});

test("digest groups by cum date with yield and payment date", () => {
  const records = [
    { ticker: "CRAB", amount: 2, cumDate: "2026-10-05", paymentDate: "2026-10-29" },
    { ticker: "AALI", amount: 233, cumDate: "2026-10-08", paymentDate: "2026-10-26" },
  ];
  const quotes = new Map([["AALI", { price: 6800 }]]);
  const embed = digestEmbed({ records, quotes, today: "2026-10-05", days: 7, status }).toJSON();

  assert.ok(embed.title.startsWith(DIGEST_TITLE));
  assert.equal(embed.fields[0].name, "⏰ Hari ini (Sen, 05 Okt) — hari terakhir beli");
  assert.equal(embed.fields[0].value, "**CRAB** · Rp2 · bayar 29 Okt");
  assert.equal(embed.fields[1].name, "Kam, 08 Okt · 3 hari lagi");

  const evening = digestEmbed({ records: records.slice(1), quotes, today: "2026-10-07", days: 7, status }).toJSON();
  assert.equal(evening.fields[0].name, "⏰ Besok (Kam, 08 Okt) — hari terakhir beli");
  assert.equal(embed.fields[1].value, "**AALI** · Rp233 · yield 3,4% · bayar 26 Okt");
});

test("digest puts watched stocks on top with the cash for their lots, then held payouts", () => {
  const records = [
    { ticker: "ASGR", amount: 297, cumDate: "2026-10-07", paymentDate: "2026-10-26" },
    { ticker: "ASII", amount: 98, cumDate: "2026-10-12", paymentDate: "2026-10-30" },
  ];
  const paid = [{ ticker: "KKGI", amount: 25, cumDate: "2026-09-23", paymentDate: "2026-10-15" }];
  const watchlist = new Map([
    ["ASII", 10],
    ["KKGI", 5],
    ["TLKM", null],
  ]);
  const quotes = new Map([["ASII", { price: 4900 }]]);
  const embed = digestEmbed({ records, paid, quotes, today: "2026-10-06", days: 7, status, watchlist }).toJSON();

  assert.deepEqual(
    embed.fields.map((f) => f.name),
    ["⭐ Pantauan", "💰 Akan Cair · perkiraan", "⏰ Besok (Rab, 07 Okt) — hari terakhir beli", "Sen, 12 Okt · 6 hari lagi"]
  );
  assert.equal(
    embed.fields[0].value,
    "**ASII** · Rp98 · yield 2% · 10 lot ≈ Rp98.000\ncum Sen, 12 Okt (6 hari lagi) · bayar 30 Okt"
  );
  assert.equal(embed.fields[1].value, "**KKGI** · 5 lot ≈ Rp12.500 · cair Kam, 15 Okt (9 hari lagi)");
  assert.equal(embed.fields[2].value, "**ASGR** · Rp297 · bayar 26 Okt");
  assert.equal(embed.fields[3].value, "⭐ **ASII** · Rp98 · yield 2% · bayar 30 Okt");
});

test("without a watchlist the digest has no watchlist fields", () => {
  const records = [{ ticker: "ASII", amount: 98, cumDate: "2026-10-12", paymentDate: "2026-10-30" }];
  const embed = digestEmbed({ records, quotes: new Map(), today: "2026-10-06", days: 7, status }).toJSON();
  assert.deepEqual(
    embed.fields.map((f) => f.name),
    ["Sen, 12 Okt · 6 hari lagi"]
  );
});

function crowded() {
  const records = [];
  for (let d = 0; d < 30; d++) {
    for (let i = 0; i < 15; i++) {
      records.push({
        ticker: `T${String(d).padStart(2, "0")}${String.fromCharCode(65 + i)}`,
        amount: 123.45,
        cumDate: addDays("2026-10-05", d),
        paymentDate: "2026-11-30",
      });
    }
  }
  return records;
}

function assertWithinLimits(embed) {
  const size =
    embed.title.length +
    embed.description.length +
    embed.footer.text.length +
    embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  assert.ok(embed.fields.length <= 25, `${embed.fields.length} fields`);
  assert.ok(size <= 6000, `embed is ${size} chars`);
  assert.ok(embed.fields.every((f) => f.value.length <= 1024));
  assert.match(embed.fields.at(-1).value, /saham lagi/);
}

test("digest stays within Discord limits on a crowded week", () => {
  const embed = digestEmbed({ records: crowded(), quotes: new Map(), today: "2026-10-05", days: 30, status }).toJSON();
  assertWithinLimits(embed);
});

test("digest stays within Discord limits with a long watchlist", () => {
  const records = crowded();
  const watchlist = new Map(records.slice(0, 60).map((r) => [r.ticker, 10]));
  const paid = records.slice(0, 40).map((r) => ({ ...r, paymentDate: "2026-10-09" }));
  const embed = digestEmbed({ records, paid, quotes: new Map(), today: "2026-10-05", days: 30, status, watchlist }).toJSON();
  assertWithinLimits(embed);
  assert.equal(embed.fields[0].name, "⭐ Pantauan");
  assert.match(embed.fields[0].value, /…dan \d+ lagi$/);
});

test("empty digest says so", () => {
  const embed = digestEmbed({ records: [], quotes: new Map(), today: "2026-10-05", days: 7, status }).toJSON();
  assert.equal(embed.description, "Tidak ada cum date dalam 7 hari ke depan.");
  assert.ok(!embed.fields?.length);
});

test("isScheduledDigest: only the bot's own non-reply digest from today", () => {
  const digest = {
    author: { id: "bot" },
    reference: null,
    createdTimestamp: Date.parse("2026-10-06T13:00:00Z"), // 20:00 WIB
    embeds: [{ title: `${DIGEST_TITLE} · Sel, 06 Okt 2026` }],
  };
  const is = (m, today = "2026-10-06") => isScheduledDigest(m, { botId: "bot", today });

  assert.equal(is(digest), true);
  // `ringkasan` at lunch: same title, but a reply — that evening's digest still posts
  assert.equal(is({ ...digest, reference: { messageId: "1" } }), false);
  assert.equal(is(digest, "2026-10-07"), false);
  assert.equal(is({ ...digest, author: { id: "someone" } }), false);
  assert.equal(is({ ...digest, embeds: [{ title: "⭐ Pantauan Dividen" }] }), false);
  assert.equal(is({ ...digest, embeds: [] }), false);
});

test("watchlist view: changes, announced dividends, payouts, the list with names", () => {
  const list = new Map([
    ["BBRY", null],
    ["ASII", 10],
    ["KKGI", 5],
  ]);
  const records = [{ ticker: "ASII", amount: 98, cumDate: "2026-10-12", paymentDate: "2026-10-30" }];
  const paid = [{ ticker: "KKGI", amount: 25, cumDate: "2026-09-23", paymentDate: "2026-10-15" }];
  const quotes = new Map([
    ["ASII", { price: 4900, name: "Astra International Tbk" }],
    ["KKGI", { price: 450, name: "Resource Alam Indonesia Tbk" }],
    ["BBRY", null],
  ]);
  const notes = ["⭐ **ASII** dipantau · 10 lot"];
  const embed = watchlistEmbed({ list, records, paid, quotes, today: "2026-10-06", status, notes, pinned: true }).toJSON();

  assert.equal(embed.description, "⭐ **ASII** dipantau · 10 lot\n\n**3 saham** dipantau, 2 dengan lot.");
  assert.deepEqual(
    embed.fields.map((f) => f.name),
    ["Dividen yang Akan Datang", "💰 Akan Cair · perkiraan", "Daftar (3)"]
  );
  assert.equal(
    embed.fields[0].value,
    "**ASII** · Rp98 · yield 2% · 10 lot ≈ Rp98.000\ncum Sen, 12 Okt (6 hari lagi) · bayar 30 Okt"
  );
  assert.equal(embed.fields[1].value, "**KKGI** · 5 lot ≈ Rp12.500 · cair Kam, 15 Okt (9 hari lagi)");
  assert.equal(
    embed.fields[2].value,
    "**ASII** · 10 lot — Astra International Tbk\n" +
      "**BBRY** — ❓ tidak ditemukan di Yahoo\n" +
      "**KKGI** · 5 lot — Resource Alam Indonesia Tbk"
  );
});

test("watchlist view warns while its message is not pinned", () => {
  const list = new Map([["ASII", null]]);
  const view = (pinned) =>
    watchlistEmbed({ list, records: [], paid: [], quotes: new Map(), today: "2026-10-06", status, pinned }).toJSON();
  assert.match(view(false).description, /izin \*Pin Messages\*/);
  assert.doesNotMatch(view(true).description, /Pin Messages/);
  assert.doesNotMatch(view(null).description, /Pin Messages/);
  assert.equal(view(true).fields[0].value, "Belum ada jadwal dividen yang diumumkan.");
});

test("empty watchlist view explains how to add a stock", () => {
  const embed = watchlistEmbed({
    list: new Map(),
    records: [],
    paid: [],
    quotes: new Map(),
    today: "2026-10-06",
    status,
  }).toJSON();
  assert.match(embed.description, /^Belum ada saham dipantau\. Tambahkan dengan `pantau BBRI`/);
  assert.ok(!embed.fields?.length);
});
