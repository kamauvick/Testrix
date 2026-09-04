'use strict';

const emptySummary = () => ({
  total: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  flaky: 0,
  duration: 0,
});

// ANSI escape / CSI colour sequences that reporters (Playwright, Vitest, Pest)
// leave in <failure> bodies and stdout when ANSI stripping is disabled. Written
// with \u escapes so the source file stays free of raw control characters.
const ANSI_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007|' +
    '(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~])',
  'g',
);

// C0 control characters XML 1.0 forbids even though some reporters emit them
// (Playwright with ANSI on, a few CI tools). Tab / LF / CR are kept.
// eslint-disable-next-line no-control-regex
const XML_FORBIDDEN_CONTROL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]', 'g');

/** Remove ANSI escape sequences and coerce to a plain string. */
function stripAnsi(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(ANSI_PATTERN, '');
}

/**
 * Make a raw XML chunk safe for a strict streaming parser: drop ANSI colour
 * sequences and any remaining forbidden control characters. Without this a
 * Playwright JUnit report with colour codes in `<failure message="…">` hard-fails.
 */
function sanitizeXmlChunk(chunk) {
  return String(chunk).replace(ANSI_PATTERN, '').replace(XML_FORBIDDEN_CONTROL, '');
}

/**
 * Normalise loose status words to passed/failed/skipped/flaky.
 *
 * Handles Vitest/Pest/Mocha wording plus Playwright's two status vocabularies:
 * the spec level (`expected` / `unexpected` / `flaky` / `skipped`) and the
 * result level (`passed` / `failed` / `timedOut` / `interrupted` / `skipped`).
 */
function normaliseStatus(raw) {
  const value = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');

  if (['pass', 'passed', 'ok', 'success', 'expected'].includes(value)) return 'passed';
  if (
    ['fail', 'failed', 'error', 'unexpected', 'timedout', 'interrupted', 'crashed'].includes(value)
  )
    return 'failed';
  if (['skip', 'skipped', 'pending', 'disabled', 'didnotrun'].includes(value)) return 'skipped';
  if (value === 'flaky') return 'flaky';
  return value || 'passed';
}

/**
 * Increment the matching counter on a summary object. Flaky tests count towards
 * `total` and `flaky` only (mirroring how Playwright reports them - a flaky test
 * ultimately passed, but is tracked separately for flakiness metrics).
 */
function countStatus(summary, status) {
  if (status === 'passed') summary.passed += 1;
  else if (status === 'failed') summary.failed += 1;
  else if (status === 'skipped') summary.skipped += 1;
  else if (status === 'flaky') summary.flaky += 1;
}

/** Numeric keys merged when combining the summaries of several report files. */
const SUMMARY_KEYS = ['total', 'passed', 'failed', 'skipped', 'flaky', 'duration'];

module.exports = {
  emptySummary,
  normaliseStatus,
  countStatus,
  stripAnsi,
  sanitizeXmlChunk,
  SUMMARY_KEYS,
};
