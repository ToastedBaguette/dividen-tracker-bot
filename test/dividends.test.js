import { test } from "node:test";
import assert from "node:assert/strict";
import {
  daysBetween,
  dividendYield,
  firstBuyableDate,
  formatDateId,
  groupByCumDate,
  isDigestDay,
  normalizeTicker,
  nowParts,
  parseAmount,
  parseDate,
  relativeDay,
  upcoming,
} from "../src/dividends.js";

test("parseDate reads SahamIDX dates", () => {
  assert.equal(parseDate("08-Oct-2026"), "2026-10-08");
  assert.equal(parseDate("6-May-2026"), "2026-05-06");
  assert.equal(parseDate("06-Agu-2026"), "2026-08-06");
  assert.equal(parseDate(" 31-Dec-2026 "), "2026-12-31");
  assert.equal(parseDate("2026-10-08"), null);
  assert.equal(parseDate("-"), null);
  assert.equal(parseDate(undefined), null);
});

test("parseAmount", () => {
  assert.equal(parseAmount("611.93"), 611.93);
  assert.equal(parseAmount("1,234.5"), 1234.5);
  assert.equal(parseAmount("-"), null);
  assert.equal(parseAmount("0"), null);
});

test("nowParts uses Jakarta time whatever the host zone", () => {
  // 2026-10-04 18:30 UTC is already 5 October 01:30 in Jakarta
  assert.deepEqual(nowParts(new Date("2026-10-04T18:30:00Z")), { date: "2026-10-05", time: "01:30" });
});

test("date helpers", () => {
  assert.equal(daysBetween("2026-10-03", "2026-10-08"), 5);
  assert.equal(daysBetween("2026-12-30", "2027-01-02"), 3);
  assert.equal(formatDateId("2026-10-08"), "Kam, 08 Okt");
  assert.equal(formatDateId("2026-10-08", { year: true }), "Kam, 08 Okt 2026");
  assert.equal(relativeDay("2026-10-03", "2026-10-03"), "hari ini");
  assert.equal(relativeDay("2026-10-04", "2026-10-03"), "besok");
  assert.equal(relativeDay("2026-10-08", "2026-10-03"), "5 hari lagi");
});

const records = [
  { ticker: "GEMS", cumDate: "2026-10-08" },
  { ticker: "AALI", cumDate: "2026-10-08" },
  { ticker: "CRAB", cumDate: "2026-10-05" },
  { ticker: "CDIA", cumDate: "2026-09-30" },
  { ticker: "BBRI", cumDate: "2026-10-20" },
];

test("upcoming keeps cum dates from a date on, nearest first", () => {
  assert.deepEqual(
    upcoming(records, "2026-10-05").map((r) => r.ticker),
    ["CRAB", "AALI", "GEMS", "BBRI"]
  );
  assert.deepEqual(
    upcoming(records, "2026-10-06").map((r) => r.ticker),
    ["AALI", "GEMS", "BBRI"]
  );
  assert.deepEqual(
    upcoming(records, "2026-10-03", { until: "2026-10-10" }).map((r) => r.ticker),
    ["CRAB", "AALI", "GEMS"]
  );
});

test("firstBuyableDate: today until market close, tomorrow after", () => {
  assert.equal(firstBuyableDate({ date: "2026-10-05", time: "08:00" }), "2026-10-05");
  assert.equal(firstBuyableDate({ date: "2026-10-05", time: "15:59" }), "2026-10-05");
  assert.equal(firstBuyableDate({ date: "2026-10-05", time: "16:00" }), "2026-10-06");
  assert.equal(firstBuyableDate({ date: "2026-10-05", time: "20:00" }), "2026-10-06");
});

test("isDigestDay: evening digest Sunday–Thursday, morning digest Monday–Friday", () => {
  // 2026-10-04 is a Sunday
  const week = ["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"];
  assert.deepEqual(
    week.map((d) => isDigestDay(d, "20:00")),
    [true, true, true, true, true, false, false]
  );
  assert.deepEqual(
    week.map((d) => isDigestDay(d, "08:00")),
    [false, true, true, true, true, true, false]
  );
});

test("groupByCumDate", () => {
  const groups = groupByCumDate(upcoming(records, "2026-10-03", { until: "2026-10-10" }));
  assert.deepEqual(
    groups.map((g) => [g.cumDate, g.records.map((r) => r.ticker)]),
    [
      ["2026-10-05", ["CRAB"]],
      ["2026-10-08", ["AALI", "GEMS"]],
    ]
  );
});

test("dividendYield", () => {
  assert.equal(dividendYield(154, 3080), 5);
  assert.equal(dividendYield(154, null), null);
  assert.equal(dividendYield(null, 3080), null);
});

test("normalizeTicker", () => {
  assert.equal(normalizeTicker("bbri"), "BBRI");
  assert.equal(normalizeTicker("BBRI.JK"), "BBRI");
  assert.equal(normalizeTicker("BBRI4"), null);
  assert.equal(normalizeTicker("halo dunia"), null);
});
