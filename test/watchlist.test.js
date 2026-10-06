import { test } from "node:test";
import assert from "node:assert/strict";
import { WATCHLIST_TITLE } from "../src/embeds.js";
import {
  MAX_WATCHLIST,
  applyWatchChange,
  createWatchlistStore,
  formatWatchlist,
  parseWatchArgs,
  parseWatchlist,
} from "../src/watchlist.js";

test("parseWatchArgs reads tickers with optional lot counts", () => {
  assert.deepEqual(parseWatchArgs("bbri"), [{ ticker: "BBRI" }]);
  assert.deepEqual(parseWatchArgs("bbri 10 asii 5 lot tlkm"), [
    { ticker: "BBRI", lots: 10 },
    { ticker: "ASII", lots: 5 },
    { ticker: "TLKM" },
  ]);
  assert.deepEqual(parseWatchArgs("bbri.jk 1.000"), [{ ticker: "BBRI", lots: 1000 }]);
  assert.deepEqual(parseWatchArgs("bbri 0"), [{ ticker: "BBRI", lots: 0 }]);
  assert.equal(parseWatchArgs("10 bbri"), null);
  assert.equal(parseWatchArgs("bbri 10 20"), null);
  assert.equal(parseWatchArgs("bbri lot"), null);
  assert.equal(parseWatchArgs("bbri 1,5"), null);
  assert.equal(parseWatchArgs("semua"), null);
  assert.equal(parseWatchArgs(""), null);
});

test("applyWatchChange adds, keeps, sets and clears lots, and removes", () => {
  const start = new Map([["BBRI", 10]]);
  let r = applyWatchChange(start, "add", [{ ticker: "ASII", lots: 5 }, { ticker: "BBRI" }, { ticker: "TLKM" }]);
  assert.deepEqual(
    [...r.list],
    [
      ["BBRI", 10],
      ["ASII", 5],
      ["TLKM", null],
    ]
  );
  assert.deepEqual(r.lines, ["⭐ **ASII** dipantau · 5 lot", "⭐ **BBRI** dipantau · 10 lot", "⭐ **TLKM** dipantau"]);
  assert.deepEqual([...start], [["BBRI", 10]]); // input untouched

  r = applyWatchChange(r.list, "add", [{ ticker: "BBRI", lots: 0 }]);
  assert.equal(r.list.get("BBRI"), null);
  assert.deepEqual(r.lines, ["⭐ **BBRI** dipantau"]);

  r = applyWatchChange(r.list, "remove", [{ ticker: "TLKM" }, { ticker: "UNVR" }]);
  assert.deepEqual([...r.list.keys()], ["BBRI", "ASII"]);
  assert.deepEqual(r.lines, ["🗑️ **TLKM** dilepas", "ℹ️ **UNVR** tidak ada di pantauan"]);
});

test("applyWatchChange stops adding at the maximum", () => {
  const full = new Map(Array.from({ length: MAX_WATCHLIST }, (_, i) => [`T${String(i).padStart(3, "0")}`, null]));
  const r = applyWatchChange(full, "add", [{ ticker: "BBRI" }, { ticker: "T001", lots: 3 }]);
  assert.equal(r.list.size, MAX_WATCHLIST);
  assert.equal(r.list.has("BBRI"), false);
  assert.match(r.lines[0], /maksimal 50 saham/);
  assert.equal(r.list.get("T001"), 3); // stocks already on the list can still change
});

test("the pinned message text round-trips", () => {
  const list = new Map([
    ["TLKM", null],
    ["BBRI", 10],
    ["ASII", 1500],
  ]);
  const text = formatWatchlist(list);
  assert.equal(text, "ASII · 1500 lot\nBBRI · 10 lot\nTLKM");
  assert.deepEqual([...parseWatchlist(text)].sort(), [...list].sort());
  assert.deepEqual([...parseWatchlist("(kosong)")], []);
});

// --- store, against a fake Discord channel ---

const BOT = "bot-id";

function fakeMessage(embeds, { author = BOT, pinned = false, canPin = true } = {}) {
  const m = {
    author: { id: author },
    embeds: embeds.map((e) => (e.toJSON ? e.toJSON() : e)),
    pinned,
    canPin,
    deleted: false,
    edits: 0,
    async edit({ embeds: next }) {
      if (m.deleted) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
      m.embeds = next.map((e) => e.toJSON());
      m.edits++;
      return m;
    },
    async pin() {
      if (!m.canPin) throw Object.assign(new Error("Missing Permissions"), { code: 50013 });
      m.pinned = true;
      return m;
    },
    async fetch() {
      return m;
    },
  };
  return m;
}

function fakeChannel({ pins = [], canPin = true, pageSize = 50 } = {}) {
  const channel = {
    sent: [],
    pinRequests: [],
    messages: {
      async fetchPins({ before } = {}) {
        channel.pinRequests.push(before);
        const start = before === undefined ? 0 : pins.findIndex((p) => p.pinnedTimestamp === before) + 1;
        return { items: pins.slice(start, start + pageSize), hasMore: start + pageSize < pins.length };
      },
    },
    async send({ embeds }) {
      const m = fakeMessage(embeds, { canPin });
      channel.sent.push(m);
      return m;
    },
  };
  return channel;
}

const pinnedAt = (message, pinnedTimestamp) => ({ message, pinnedTimestamp });
const listMessage = (description, opts) =>
  fakeMessage([{ title: WATCHLIST_TITLE, description }], { pinned: true, ...opts });
const storeOn = (channel) => createWatchlistStore({ channel: async () => channel, botId: () => BOT });
const add = (...entries) => (list) => applyWatchChange(list, "add", entries);

test("store reads the bot's own pinned list message", async () => {
  const channel = fakeChannel({
    pins: [
      pinnedAt(listMessage("BBRI", { author: "someone" }), 3),
      pinnedAt(fakeMessage([{ title: "📅 Dividen Terdekat" }]), 2),
      pinnedAt(listMessage("ASII · 5 lot\nBBRI"), 1),
    ],
  });
  const store = storeOn(channel);
  assert.deepEqual(
    [...(await store.get())],
    [
      ["ASII", 5],
      ["BBRI", null],
    ]
  );
  assert.deepEqual(store.status(), { loaded: true, size: 2, pinned: true });
});

test("store pages through the pins", async () => {
  const others = [10, 9, 8].map((t) => pinnedAt(fakeMessage([{ title: "lain" }]), t));
  const channel = fakeChannel({ pins: [...others, pinnedAt(listMessage("TLKM"), 1)], pageSize: 2 });
  assert.deepEqual([...(await storeOn(channel).get())], [["TLKM", null]]);
  assert.deepEqual(channel.pinRequests, [undefined, 9]);
});

test("first change posts the list message and pins it; later changes edit it", async () => {
  const channel = fakeChannel();
  const store = storeOn(channel);
  await store.update(add({ ticker: "BBRI", lots: 10 }));
  assert.equal(channel.sent.length, 1);
  const [m] = channel.sent;
  assert.equal(m.pinned, true);
  assert.equal(m.embeds[0].title, WATCHLIST_TITLE);
  assert.equal(m.embeds[0].description, "BBRI · 10 lot");

  const { list, lines } = await store.update(add({ ticker: "ASII" }));
  assert.equal(channel.sent.length, 1);
  assert.equal(m.edits, 1);
  assert.equal(m.embeds[0].description, "ASII\nBBRI · 10 lot");
  assert.equal(list.size, 2);
  assert.deepEqual(lines, ["⭐ **ASII** dipantau"]);
  assert.deepEqual(store.status(), { loaded: true, size: 2, pinned: true });
});

test("without pin permission the list is saved unpinned, and pinned once allowed", async () => {
  const channel = fakeChannel({ canPin: false });
  const store = storeOn(channel);
  await store.update(add({ ticker: "BBRI" }));
  assert.equal(store.status().pinned, false);
  assert.equal(channel.sent[0].embeds[0].description, "BBRI");

  channel.sent[0].canPin = true; // operator grants Pin Messages
  await store.update(add({ ticker: "ASII" }));
  assert.equal(store.status().pinned, true);
  assert.equal(channel.sent.length, 1);
});

test("a list message pinned by hand counts as pinned", async () => {
  const channel = fakeChannel({ canPin: false });
  const store = storeOn(channel);
  await store.update(add({ ticker: "BBRI" }));
  channel.sent[0].pinned = true; // operator pins it
  await store.update(add({ ticker: "ASII" }));
  assert.equal(store.status().pinned, true);
});

test("a deleted list message is posted again", async () => {
  const old = listMessage("BBRI");
  const channel = fakeChannel({ pins: [pinnedAt(old, 1)] });
  const store = storeOn(channel);
  await store.get();
  old.deleted = true;
  await store.update(add({ ticker: "ASII" }));
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].embeds[0].description, "ASII\nBBRI");
  assert.equal(channel.sent[0].pinned, true);
});

test("an unchanged list is not saved", async () => {
  const channel = fakeChannel();
  const store = storeOn(channel);
  const { lines } = await store.update((list) => applyWatchChange(list, "remove", [{ ticker: "BBRI" }]));
  assert.deepEqual(lines, ["ℹ️ **BBRI** tidak ada di pantauan"]);
  assert.equal(channel.sent.length, 0);
  assert.equal(store.status().pinned, null);
});

test("a list that can't be read is never overwritten", async () => {
  const channel = fakeChannel();
  channel.messages.fetchPins = async () => {
    throw new Error("Missing Access");
  };
  const store = storeOn(channel);
  await assert.rejects(store.update(add({ ticker: "BBRI" })), /Missing Access/);
  assert.equal(channel.sent.length, 0);
  assert.equal(store.status().loaded, false);
});

test("a failed save keeps the old list, and later changes still run", async () => {
  const channel = fakeChannel();
  const store = storeOn(channel);
  await store.update(add({ ticker: "BBRI" }));
  const [m] = channel.sent;
  const edit = m.edit;
  m.edit = async () => {
    throw Object.assign(new Error("Missing Permissions"), { code: 50013 });
  };
  await assert.rejects(store.update(add({ ticker: "ASII" })), /Missing Permissions/);
  assert.deepEqual([...(await store.get()).keys()], ["BBRI"]);

  m.edit = edit;
  await store.update(add({ ticker: "TLKM" }));
  assert.equal(m.embeds[0].description, "BBRI\nTLKM");
});

test("concurrent changes are applied one after another", async () => {
  const channel = fakeChannel();
  const store = storeOn(channel);
  await Promise.all([
    store.update(add({ ticker: "BBRI" })),
    store.update(add({ ticker: "ASII" })),
    store.update(add({ ticker: "TLKM", lots: 2 })),
  ]);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].embeds[0].description, "ASII\nBBRI\nTLKM · 2 lot");
});

test("no channel configured", async () => {
  const store = createWatchlistStore({ channel: async () => null, botId: () => BOT });
  await assert.rejects(store.get(), /DISCORD_CHANNEL_ID/);
});
