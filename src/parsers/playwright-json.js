'use strict';

const fs = require('node:fs');

const { emptySummary, normaliseStatus, countStatus, stripAnsi } = require('./shared');
const { clampField } = require('../limits');

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
 * Recursively walk `suites` -> `specs` -> `tests`. Nested suites are `describe`
 * blocks; their titles build the `A > B > C` suite path. The spec file is only
 * set on the top-level suite, so it is inherited downwards.
 */
function walkSuites(suites, parentTitles, parentFile, summary, testCases) {
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

        testCases.push({
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

        summary.total += 1;
        countStatus(summary, info.status);
        summary.duration += info.duration;
      }
    }

    walkSuites(suite.suites, titles, file, summary, testCases);
  }
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

/**
 * Parse a Playwright JSON report (`reporter: 'json'` / `PLAYWRIGHT_JSON_OUTPUT_NAME`).
 * @param {string} filePath
 * @returns {Promise<{ summary: object, testCases: object[], startTime: ?string, endTime: ?string }>}
 */
async function parsePlaywrightJson(filePath) {
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

  const summary = emptySummary();
  const testCases = [];
  walkSuites(parsed.suites, [], null, summary, testCases);

  // Top-level `errors` are run-level failures (config load, global setup, worker
  // crash) that never made it into a spec. Surface each so the run isn't green.
  for (const err of asArray(parsed.errors)) {
    testCases.push({
      title: 'Playwright run error',
      status: 'failed',
      duration: 0,
      errorMessage: clampField(
        stripAnsi((err && err.message) || String(err) || 'Unknown run error'),
      ),
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
    });
    summary.total += 1;
    countStatus(summary, 'failed');
  }

  return { summary, testCases, ...runWindow(parsed.stats) };
}

module.exports = { parsePlaywrightJson, NotPlaywrightJsonError };
