import { test } from "node:test";
import assert from "node:assert/strict";
import { DIGEST_TITLE, digestEmbed, fmt } from "../src/embeds.js";
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

test("digest stays within Discord limits on a crowded week", () => {
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
  const embed = digestEmbed({ records, quotes: new Map(), today: "2026-10-05", days: 30, status }).toJSON();
  const size =
    embed.title.length +
    embed.description.length +
    embed.footer.text.length +
    embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);

  assert.ok(embed.fields.length <= 25);
  assert.ok(size <= 6000, `embed is ${size} chars`);
  assert.ok(embed.fields.every((f) => f.value.length <= 1024));
  assert.match(embed.fields.at(-1).value, /saham lagi/);
});

test("empty digest says so", () => {
  const embed = digestEmbed({ records: [], quotes: new Map(), today: "2026-10-05", days: 7, status }).toJSON();
  assert.equal(embed.description, "Tidak ada cum date dalam 7 hari ke depan.");
  assert.ok(!embed.fields?.length);
});
