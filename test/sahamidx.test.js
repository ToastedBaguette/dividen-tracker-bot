import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchDividends, parseDividendPage } from "../src/sahamidx.js";

const page = readFileSync(new URL("./fixtures/sahamidx-page.html", import.meta.url), "utf8");

test("parseDividendPage maps cells by data-header, not position", () => {
  const rows = parseDividendPage(page);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1], {
    ticker: "GEMS",
    amount: 611.93,
    cumDate: "2026-10-08",
    exDate: "2026-10-09",
    recordingDate: "2026-10-12",
    paymentDate: "2026-10-22",
    source: "SahamIDX",
  });
  assert.equal(rows[3].amount, 1.422181);
});

test("parseDividendPage throws when the table is gone", () => {
  assert.throws(() => parseDividendPage("<html><body>Maintenance</body></html>"), /tabel dividen tidak ditemukan/);
});

test("parseDividendPage throws when no row is readable", () => {
  const broken = page.replace(/\d{2}-[A-Z][a-z]{2}-2026/g, "2026/10/08");
  assert.throws(() => parseDividendPage(broken), /tidak terbaca/);
});

test("parseDividendPage skips a single odd row", () => {
  const odd = page.replace(">CRAB<", ">R-LQ45X<");
  assert.deepEqual(
    parseDividendPage(odd).map((r) => r.ticker),
    ["AALI", "GEMS", "CDIA"]
  );
});

function fakeFetch(pages) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const n = Number(url.match(/page\/(\d+)/)?.[1] ?? 1);
    return { ok: true, status: 200, text: async () => pages[n - 1] };
  };
  return { impl, calls };
}

test("fetchDividends stops at the first page that reaches past dates", async () => {
  const { impl, calls } = fakeFetch([page, page]);
  const rows = await fetchDividends("2026-10-03", { fetchImpl: impl });
  assert.equal(calls.length, 1);
  assert.equal(rows.length, 4);
});

test("fetchDividends reads on while a whole page is still upcoming", async () => {
  const older = page.replace(/2026/g, "2025");
  const { impl, calls } = fakeFetch([page, older, older]);
  await fetchDividends("2026-09-01", { fetchImpl: impl });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /\/page\/2$/);
});

test("fetchDividends throws on HTTP errors", async () => {
  const impl = async () => ({ ok: false, status: 503 });
  await assert.rejects(fetchDividends("2026-10-03", { fetchImpl: impl }), /HTTP 503/);
});
