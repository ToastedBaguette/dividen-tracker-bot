import { test } from "node:test";
import assert from "node:assert/strict";
import { createFeed, validate } from "../src/feed.js";

const NOW = new Date("2026-10-03T01:00:00Z"); // 08:00 WIB
const fresh = [{ ticker: "AALI", cumDate: "2026-10-08" }];

function provider(name, results) {
  let call = 0;
  return {
    name,
    calls: () => call,
    fetch: async () => {
      const result = results[Math.min(call++, results.length - 1)];
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test("validate rejects empty and stale data", () => {
  assert.throws(() => validate([], "2026-10-03"), /tidak ada data/);
  assert.throws(() => validate([{ ticker: "X", cumDate: "2026-07-01" }], "2026-10-03"), /data basi/);
  validate([{ ticker: "X", cumDate: "2026-09-01" }], "2026-10-03");
});

test("primary ok: no alert on first success", async () => {
  const alerts = [];
  const feed = createFeed({
    providers: [provider("A", [fresh])],
    onHealthChange: (h, p) => alerts.push([p, h]),
    clock: () => NOW,
  });
  await feed.refresh();
  assert.equal(feed.status().source, "A");
  assert.equal(feed.status().health, "ok");
  assert.deepEqual(alerts, []);
});

test("primary fails: fallback serves, one alert, recovery alert", async () => {
  const alerts = [];
  const primary = provider("A", [new Error("HTTP 503"), new Error("HTTP 503"), fresh]);
  const backup = provider("B", [fresh]);
  const feed = createFeed({
    providers: [primary, backup],
    onHealthChange: (h, p) => alerts.push([p, h]),
    clock: () => NOW,
  });

  await feed.refresh();
  assert.equal(feed.status().source, "B");
  assert.deepEqual(feed.status().errors, [{ provider: "A", message: "HTTP 503" }]);
  await feed.refresh(); // still failing: no second alert
  await feed.refresh(); // primary back
  assert.equal(feed.status().source, "A");
  assert.deepEqual(alerts, [
    [null, "fallback"],
    ["fallback", "ok"],
  ]);
});

test("all fail: last good data is kept and health is down", async () => {
  const alerts = [];
  const feed = createFeed({
    providers: [provider("A", [fresh, new Error("layout changed")])],
    onHealthChange: (h, p) => alerts.push([p, h]),
    clock: () => NOW,
  });
  await feed.refresh();
  await feed.refresh();
  const status = feed.status();
  assert.equal(status.health, "down");
  assert.equal(status.records, fresh);
  assert.deepEqual(alerts, [["ok", "down"]]);
});

test("stale data from the primary counts as a failure", async () => {
  const feed = createFeed({
    providers: [provider("A", [[{ ticker: "X", cumDate: "2026-06-01" }]]), provider("B", [fresh])],
    clock: () => NOW,
  });
  await feed.refresh();
  assert.equal(feed.status().source, "B");
  assert.match(feed.status().errors[0].message, /data basi/);
});

test("get serves the cache until it expires, and backs off after a failure", async () => {
  let now = NOW.getTime();
  const primary = provider("A", [fresh, new Error("down")]);
  const feed = createFeed({ providers: [primary], clock: () => new Date(now) });

  await feed.get();
  await feed.get();
  assert.equal(primary.calls(), 1);

  now += 61 * 60 * 1000; // cache expired → refresh fails
  await feed.get();
  assert.equal(primary.calls(), 2);
  now += 60 * 1000; // within the retry back-off
  await feed.get();
  assert.equal(primary.calls(), 2);
});

test("concurrent refreshes share one fetch", async () => {
  const primary = provider("A", [fresh]);
  const feed = createFeed({ providers: [primary], clock: () => NOW });
  await Promise.all([feed.refresh(), feed.refresh(), feed.get()]);
  assert.equal(primary.calls(), 1);
});
