'use strict';

/**
 * Bounds that keep memory flat regardless of report size:
 *   - MAX_FIELD_BYTES: per-string cap for errorMessage / errorStack / stdout /
 *     stderr. Playwright stdout and Java stack traces routinely run to megabytes.
 *   - DEFAULT_MAX_CASES: cap on total test cases pulled from the reports. 0 means
 *     unlimited; the CLI default is applied in config.js so it is overridable.
 */
const MAX_FIELD_BYTES = toInt(process.env.TESTRIX_MAX_FIELD_BYTES, 16 * 1024);
const DEFAULT_MAX_CASES = 200_000;

const TRUNCATED = '\n…[truncated]';

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Clamp a string to `MAX_FIELD_BYTES`, appending a marker when it was cut. */
function clampField(value, max = MAX_FIELD_BYTES) {
  if (value == null) return '';
  const str = String(value);
  if (max === 0 || str.length <= max) return str;
  return str.slice(0, Math.max(0, max - TRUNCATED.length)) + TRUNCATED;
}

module.exports = { MAX_FIELD_BYTES, DEFAULT_MAX_CASES, clampField, toInt };
