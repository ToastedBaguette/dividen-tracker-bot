import { sahamIdxProvider } from "./sahamidx.js";

/**
 * Data sources in fallback order: the first one that returns valid data wins.
 *
 * A provider is { name, fetch(today) } where fetch resolves to records shaped
 * { ticker, amount, cumDate, exDate, recordingDate, paymentDate, source } (ISO dates, IDR amount),
 * newest first, covering at least every dividend with cumDate >= today. Throw on any failure.
 * A paid fallback is added here, enabled only when its API key is set.
 */
export function buildProviders() {
  return [sahamIdxProvider];
}
