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

/**
 * Fold one parsed record into a running summary: total + the matching status
 * counter + duration. Every `parseX()` buffered wrapper does this same
 * three-line sequence; centralising it means the aggregation contract only
 * has to change in one place (as it did when `flaky` was added).
 */
function accumulate(summary, rec) {
  summary.total += 1;
  countStatus(summary, rec.status);
  summary.duration += rec.duration || 0;
}

/** `value` as an array: itself if already one, `[value]` if truthy, else `[]`. */
const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

/** A test-case record with every field defaulted, so downstream code stays simple. */
function makeCase(partial) {
  return {
    title: '',
    status: 'passed',
    duration: 0,
    errorMessage: '',
    errorStack: '',
    file: null,
    suite: null,
    project: null,
    line: null,
    retries: 0,
    flaky: false,
    attachments: [],
    stdout: '',
    stderr: '',
    ...partial,
  };
}

/** Seconds (JUnit/NUnit's native unit) to whole milliseconds (the pipeline's unit). */
const secondsToMs = (value) => Math.round((parseFloat(value) || 0) * 1000);

/**
 * Destroy a readable stream and wait for its underlying file descriptor to
 * actually be released before resolving. `stream.destroy()` only *starts*
 * teardown - the real close happens asynchronously on a later tick. On Linux,
 * unlinking/removing a directory while one of its files is still open
 * succeeds anyway, so the race was invisible there; on Windows the OS holds
 * the file locked until the fd is released, and a caller that cleans up its
 * temp dir right after a stream error rejects gets `EPERM`/`ENOTEMPTY`.
 */
function destroyStream(stream) {
  return new Promise((resolve) => {
    if (stream.destroyed) {
      resolve();
      return;
    }
    stream.once('close', resolve);
    stream.destroy();
  });
}

module.exports = {
  emptySummary,
  normaliseStatus,
  countStatus,
  stripAnsi,
  sanitizeXmlChunk,
  accumulate,
  asArray,
  makeCase,
  secondsToMs,
  destroyStream,
};
