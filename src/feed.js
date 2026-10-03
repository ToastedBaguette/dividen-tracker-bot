import { addDays, nowParts } from "./dividends.js";

const CACHE_TTL_MS = 60 * 60 * 1000;
// After a failed refresh, keep serving the cache for a while instead of hitting a broken source on every command
const RETRY_AFTER_MS = 5 * 60 * 1000;
// IDX companies go cum-dividend nearly every week; a newest cum date this old means the source stopped updating
const STALE_AFTER_DAYS = 45;

/**
 * Throws when a provider's result can't be trusted
 */
export function validate(records, today) {
  if (!Array.isArray(records) || records.length === 0) throw new Error("tidak ada data dividen");
  const newest = records.reduce((max, r) => (r.cumDate > max ? r.cumDate : max), "");
  if (newest < addDays(today, -STALE_AFTER_DAYS)) throw new Error(`data basi — cum date terbaru ${newest}`);
}

/**
 * Dividend data from the first provider that returns valid data, cached.
 *
 * Health: "ok" (first provider served), "fallback" (a later provider served), "down" (all failed —
 * the last good data, if any, keeps being served). onHealthChange fires on every change except the
 * very first "ok", so the channel hears about a broken source exactly once, and again on recovery.
 */
export function createFeed({ providers, onHealthChange = () => {}, clock = () => new Date() }) {
  const state = {
    records: [],
    fetchedAt: 0,
    source: null,
    health: null,
    errors: [],
    lastAttemptAt: 0,
  };
  let inflight = null;

  function setHealth(health) {
    const previous = state.health;
    state.health = health;
    if (health !== previous && !(previous === null && health === "ok")) {
      Promise.resolve(onHealthChange(health, previous, status())).catch((err) =>
        console.error("onHealthChange failed:", err)
      );
    }
  }

  async function attempt() {
    const now = clock();
    const today = nowParts(now).date;
    const errors = [];
    state.lastAttemptAt = now.getTime();

    for (const [i, provider] of providers.entries()) {
      try {
        const records = await provider.fetch(today);
        validate(records, today);
        Object.assign(state, { records, fetchedAt: clock().getTime(), source: provider.name, errors });
        setHealth(i === 0 ? "ok" : "fallback");
        return;
      } catch (err) {
        console.error(`Provider ${provider.name} failed:`, err.message);
        errors.push({ provider: provider.name, message: err.message });
      }
    }

    state.errors = errors;
    setHealth("down");
  }

  /**
   * Fetch now, whatever the cache age
   */
  async function refresh() {
    inflight ??= attempt().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  /**
   * Cached data, refreshed first when older than maxAgeMs. Never throws — check fetchedAt === 0
   * for "no data at all".
   */
  async function get({ maxAgeMs = CACHE_TTL_MS } = {}) {
    const now = clock().getTime();
    const expired = now - state.fetchedAt > maxAgeMs;
    const coolingDown = state.health === "down" && now - state.lastAttemptAt < RETRY_AFTER_MS;
    if (expired && !coolingDown) await refresh();
    return status();
  }

  function status() {
    return {
      records: state.records,
      fetchedAt: state.fetchedAt,
      source: state.source,
      health: state.health,
      errors: state.errors,
      providers: providers.map((p) => p.name),
    };
  }

  return { get, refresh, status };
}
