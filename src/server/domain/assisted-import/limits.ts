/**
 * Everything this feature is allowed to spend, in one place.
 *
 * A model reading an uploaded file is the only part of this product that costs
 * money per use and can be made to cost more by whoever uploads the file. That
 * is a different shape of risk from anything else here, and it wants bounds
 * that are visible rather than scattered through the call site:
 *
 *   - **Bytes**, so a 400 MB scan is refused before it is read into memory.
 *   - **Pages**, so a year of PDF calendars is refused rather than truncated
 *     silently — a partial extraction that looks complete is the failure this
 *     whole feature has to avoid.
 *   - **A timeout**, so a hung request fails the upload instead of holding a
 *     connection until something else times out first.
 *   - **A cost ceiling** per extraction, checked against an estimate *before*
 *     the call and recorded as an actual after it.
 *
 * All four are environment configuration with defaults that are sane for a
 * residency block. They are read at call time rather than at import time, so a
 * deployment can change one without a rebuild and so tests can set them.
 */

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface AssistedImportLimits {
  maxBytes: number;
  maxPages: number;
  timeoutMs: number;
  /** Per extraction, in millionths of a dollar. 50 000 = five cents. */
  maxCostMicros: number;
  /** Below this the row is flagged for review and cannot be committed unlooked-at. */
  confidenceFloor: number;
}

export function assistedImportLimits(): AssistedImportLimits {
  return {
    maxBytes: number("ASSISTED_IMPORT_MAX_BYTES", 10 * 1024 * 1024),
    maxPages: number("ASSISTED_IMPORT_MAX_PAGES", 20),
    timeoutMs: number("ASSISTED_IMPORT_TIMEOUT_MS", 120_000),
    maxCostMicros: number("ASSISTED_IMPORT_MAX_COST_MICROS", 500_000),
    confidenceFloor: number("ASSISTED_IMPORT_CONFIDENCE_FLOOR", 0.85),
  };
}

/**
 * What a run cost, from the token counts the API reports.
 *
 * Deliberately a table rather than a live price lookup: a price that changes
 * under a running deployment would make the ceiling mean something different
 * from one upload to the next, and the number this produces is used to *refuse*
 * things. Rates are per million tokens, in micros.
 */
const RATES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5": { input: 3_000_000, output: 15_000_000 },
  "claude-opus-4-5": { input: 5_000_000, output: 25_000_000 },
  "claude-haiku-4-5": { input: 1_000_000, output: 5_000_000 },
};

/** The rate used when the configured model is not in the table: the dearest. */
const UNKNOWN_MODEL_RATE = { input: 5_000_000, output: 25_000_000 };

export function costMicros(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const key = Object.keys(RATES).find((name) => model.startsWith(name));
  const rate = key ? RATES[key] : UNKNOWN_MODEL_RATE;
  return Math.round(
    (inputTokens * rate.input) / 1_000_000 + (outputTokens * rate.output) / 1_000_000,
  );
}
