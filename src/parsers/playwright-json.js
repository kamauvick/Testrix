'use strict';

const fs = require('node:fs');

const { normaliseStatus, countStatus, stripAnsi, emptySummary } = require('./shared');
const { clampField, toInt } = require('../limits');

// Above this size, parse via stream-json instead of JSON.parse so a huge report
// (thousands of specs) never has to sit fully in memory as a JS object tree.
// Read per-call (not once at module load) so it can be overridden at runtime -
// tests rely on this to exercise the streaming path without a huge fixture.
const streamThresholdBytes = () =>
  toInt(process.env.TESTRIX_JSON_STREAM_THRESHOLD_BYTES, 20 * 1024 * 1024);

/**
 * Error thrown when a `.json` file is valid JSON but not a Playwright report.
 * The publisher treats this as "skip and warn" rather than a hard failure, so a
 * stray `package.json` in the reports directory doesn't abort the run.
 */
class NotPlaywrightJsonError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotPlaywrightJsonError';
    this.skippable = true;
  }
}

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

/** Flatten Playwright's `stdout` / `stderr` (`[{text}|{buffer}]`) to a string. */
function streamText(entries) {
  return asArray(entries)
    .map((e) => (typeof e === 'string' ? e : e && (e.text || e.buffer) ? e.text || e.buffer : ''))
    .join('')
    .trim();
}

/** Classify Playwright attachments so the payload can fill screenshot/video/trace. */
function mapAttachments(rawAttachments) {
  const attachments = [];
  for (const att of asArray(rawAttachments)) {
    if (!att || (!att.path && !att.body)) continue;
    attachments.push({
      name: att.name || '',
      contentType: att.contentType || '',
      path: att.path || null,
    });
  }
  return attachments;
}

/**
 * Reduce a spec's `results` (one entry per attempt) to a single outcome.
 * `spec.tests[].status` is authoritative for expected/unexpected/flaky/skipped;
 * the individual results give us duration, errors, retries and attachments.
 */
function summariseTest(test) {
  const results = asArray(test.results);
  const last = results[results.length - 1] || {};
  const status = normaliseStatus(test.status || last.status || 'passed');

  const errorsOnLast = asArray(last.errors).length
    ? asArray(last.errors)
    : last.error
      ? [last.error]
      : [];
  const errorMessage = stripAnsi(errorsOnLast.map((e) => e && e.message).filter(Boolean)[0] || '');
  const errorStack = stripAnsi(
    errorsOnLast
      .map((e) => e && (e.stack || e.snippet))
      .filter(Boolean)
      .join('\n\n'),
  );

  const attachments = results.flatMap((r) => mapAttachments(r.attachments));
  const retries = Math.max(results.length - 1, Number(last.retry) || 0, 0);

  return {
    status,
    duration: Math.round(Number(last.duration) || 0), // already milliseconds
    retries,
    flaky: status === 'flaky',
    errorMessage: clampField(errorMessage),
    errorStack: clampField(errorStack),
    attachments,
    stdout: clampField(streamText(last.stdout)),
    stderr: clampField(stripAnsi(streamText(last.stderr))),
  };
}

/**
 * Recursively walk one `suites` array -> `specs` -> `tests`, pushing test-case
 * records into `out`. Nested suites are `describe` blocks; their titles build
 * the `A / B / C` suite path. The spec file is only set on the top-level suite,
 * so it is inherited downwards. Takes a single top-level suite (or a handful)
 * so it can run once per streamed suite as well as over a fully-parsed array.
 */
function walkSuites(suites, parentTitles, parentFile, out) {
  for (const suite of asArray(suites)) {
    const titles = suite.title ? [...parentTitles, suite.title] : parentTitles;
    const file = suite.file || parentFile || null;

    for (const spec of asArray(suite.specs)) {
      for (const test of asArray(spec.tests)) {
        const info = summariseTest(test);
        const project = test.projectName || test.projectId || null;
        // Match the JUnit parser's `A / B / C` suite path. Playwright's
        // top-level suite title is the spec file path; nested titles are
        // `describe` blocks.
        const suitePath = titles.join(' / ') || null;

        out.push({
          title: spec.title || test.title || '',
          status: info.status,
          duration: info.duration,
          errorMessage: info.errorMessage,
          errorStack: info.errorStack,
          file,
          suite: suitePath,
          project,
          line: Number(spec.line) || Number(test.line) || null,
          retries: info.retries,
          flaky: info.flaky,
          attachments: info.attachments,
          stdout: info.stdout,
          stderr: info.stderr,
        });
      }
    }

    walkSuites(suite.suites, titles, file, out);
  }
}

/** Build the synthetic failed record for one top-level Playwright run error. */
function runErrorRecord(err) {
  return {
    title: 'Playwright run error',
    status: 'failed',
    duration: 0,
    errorMessage: clampField(stripAnsi((err && err.message) || String(err) || 'Unknown run error')),
    errorStack: clampField(stripAnsi((err && (err.stack || err.snippet)) || '')),
    file: (err && err.location && err.location.file) || null,
    suite: null,
    project: null,
    line: (err && err.location && err.location.line) || null,
    retries: 0,
    flaky: false,
    attachments: [],
    stdout: '',
    stderr: '',
  };
}

/** Run window from Playwright's `stats.startTime` (ISO) + `stats.duration` (ms). */
function runWindow(stats) {
  const startMs = Date.parse((stats || {}).startTime);
  if (!Number.isFinite(startMs)) return { startTime: null, endTime: null };
  const startTime = new Date(startMs).toISOString();
  const durationMs = Number((stats || {}).duration);
  return {
    startTime,
    endTime: Number.isFinite(durationMs) ? new Date(startMs + durationMs).toISOString() : startTime,
  };
}

/** Parse the whole file with JSON.parse - the common case, well under the streaming threshold. */
async function* streamSmall(filePath, acc) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new NotPlaywrightJsonError(`Not valid JSON: ${err.message}`);
  }

  const looksLikePlaywright =
    parsed && Array.isArray(parsed.suites) && (parsed.config || parsed.stats || parsed.errors);
  if (!looksLikePlaywright) {
    throw new NotPlaywrightJsonError(
      'JSON file is not a Playwright report (no `suites` array with `config` / `stats`)',
    );
  }

  const out = [];
  walkSuites(parsed.suites, [], null, out);
  yield* out;

  // Top-level `errors` are run-level failures (config load, global setup, worker
  // crash) that never made it into a spec. Surface each so the run isn't green.
  for (const err of asArray(parsed.errors)) yield runErrorRecord(err);

  Object.assign(acc, runWindow(parsed.stats));
}

/** Peek at the start of a large file to sanity-check it's a Playwright report without buffering it. */
function looksLikePlaywrightHeuristic(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.toString('utf8', 0, n);
    return /"suites"\s*:/.test(head) && /"(config|stats|errors)"\s*:/.test(head);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Stream a large Playwright JSON report with `stream-json`: the `suites` array
 * is assembled one top-level entry (one spec file) at a time rather than
 * loading the whole document, so peak memory tracks the largest single spec
 * file instead of the whole run. `errors` / `stats` are tiny and read fully.
 */
async function* streamLarge(filePath, acc) {
  if (!looksLikePlaywrightHeuristic(filePath)) {
    throw new NotPlaywrightJsonError(
      'JSON file does not look like a Playwright report (no `suites`/`config`/`stats` near the start)',
    );
  }

  const { parser } = require('stream-json');
  const { pick } = require('stream-json/filters/Pick');
  const { streamArray } = require('stream-json/streamers/StreamArray');
  const { streamValues } = require('stream-json/streamers/StreamValues');

  const tokens = fs.createReadStream(filePath).pipe(parser());
  let streamErr = null;
  tokens.on('error', (e) => {
    streamErr = streamErr || e;
  });

  const errors = [];
  tokens
    .pipe(pick({ filter: 'errors' }))
    .pipe(streamArray())
    .on('data', ({ value }) => errors.push(value))
    .on('error', (e) => {
      streamErr = streamErr || e;
    });

  let stats = {};
  tokens
    .pipe(pick({ filter: 'stats' }))
    .pipe(streamValues())
    .on('data', ({ value }) => {
      stats = value;
    })
    .on('error', (e) => {
      streamErr = streamErr || e;
    });

  const suites = tokens.pipe(pick({ filter: 'suites' })).pipe(streamArray());
  for await (const { value: suite } of suites) {
    if (streamErr) throw streamErr;
    const out = [];
    walkSuites([suite], [], null, out);
    yield* out;
  }
  if (streamErr) throw streamErr;

  for (const err of asArray(errors)) yield runErrorRecord(err);
  Object.assign(acc, runWindow(stats));
}

/**
 * Stream test-case records from a Playwright JSON report
 * (`reporter: 'json'` / `PLAYWRIGHT_JSON_OUTPUT_NAME`).
 * @param {string} filePath
 * @param {{ startTime?: ?string, endTime?: ?string }} [acc] filled with the run window
 * @returns {AsyncGenerator<object>}
 */
function streamPlaywrightJson(filePath, acc = {}) {
  const { size } = fs.statSync(filePath);
  return size > streamThresholdBytes() ? streamLarge(filePath, acc) : streamSmall(filePath, acc);
}

/**
 * Buffered convenience wrapper - drains {@link streamPlaywrightJson} into an array.
 * @param {string} filePath
 * @returns {Promise<{ summary: object, testCases: object[], startTime: ?string, endTime: ?string }>}
 */
async function parsePlaywrightJson(filePath) {
  const acc = {};
  const summary = emptySummary();
  const testCases = [];
  for await (const rec of streamPlaywrightJson(filePath, acc)) {
    testCases.push(rec);
    summary.total += 1;
    countStatus(summary, rec.status);
    summary.duration += rec.duration || 0;
  }
  return { summary, testCases, startTime: acc.startTime ?? null, endTime: acc.endTime ?? null };
}

module.exports = { parsePlaywrightJson, streamPlaywrightJson, NotPlaywrightJsonError };
