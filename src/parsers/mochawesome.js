'use strict';

const fs = require('node:fs');

const { stripAnsi, normaliseStatus, emptySummary, accumulate, asArray } = require('./shared');
const { clampField } = require('../limits');

/**
 * Error thrown when a `.json` file is valid JSON but not a Mochawesome report.
 */
class NotMochawesomeJsonError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotMochawesomeJsonError';
    this.skippable = true;
  }
}

/** Does this parsed object look like a Mochawesome report? */
function looksLikeMochawesome(parsed) {
  return Boolean(parsed && parsed.stats && Array.isArray(parsed.results));
}

/** Recursively walk one file-result's `suites` -> `tests`, building a suite path. */
function walkSuites(suites, parentTitles, file, out) {
  for (const suite of asArray(suites)) {
    const titles = suite.title ? [...parentTitles, suite.title] : parentTitles;

    for (const test of asArray(suite.tests)) {
      const status = normaliseStatus(
        test.state || (test.pending ? 'pending' : test.pass ? 'passed' : 'failed'),
      );
      const err = test.err || {};
      out.push({
        title: test.title || test.fullTitle || '',
        status,
        duration: Math.round(Number(test.duration) || 0),
        errorMessage: clampField(stripAnsi(err.message || '')),
        errorStack: clampField(stripAnsi(err.estack || err.stack || '')),
        file,
        suite: titles.join(' / ') || null,
        project: null,
        line: null,
        retries: Number(test.currentRetry) || 0,
        flaky: false,
        attachments: [],
        stdout: '',
        stderr: '',
      });
    }

    walkSuites(suite.suites, titles, file, out);
  }
}

/** Run window from Mochawesome's `stats.start` / `stats.end` (ISO timestamps). */
function runWindow(stats) {
  const startMs = Date.parse((stats || {}).start);
  const endMs = Date.parse((stats || {}).end);
  return {
    startTime: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
    endTime: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null,
  };
}

/**
 * Stream test-case records from a Mochawesome JSON report (Cypress's default
 * `mochawesome` reporter, or plain Mocha with `--reporter mochawesome`).
 * @param {string} filePath
 * @param {{ startTime?: ?string, endTime?: ?string }} [acc]
 * @returns {AsyncGenerator<object>}
 */
async function* streamMochawesome(filePath, acc = {}) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new NotMochawesomeJsonError(`Not valid JSON: ${err.message}`);
  }
  if (!looksLikeMochawesome(parsed)) {
    throw new NotMochawesomeJsonError(
      'JSON file is not a Mochawesome report (no `stats` + `results` array)',
    );
  }

  const out = [];
  for (const fileResult of asArray(parsed.results)) {
    walkSuites(fileResult.suites, [], fileResult.file || fileResult.fullFile || null, out);
  }
  Object.assign(acc, runWindow(parsed.stats));
  yield* out;
}

/**
 * Buffered convenience wrapper - drains {@link streamMochawesome} into an array.
 * @param {string} filePath
 * @returns {Promise<{ summary: object, testCases: object[], startTime: ?string, endTime: ?string }>}
 */
async function parseMochawesome(filePath) {
  const acc = {};
  const summary = emptySummary();
  const testCases = [];
  for await (const rec of streamMochawesome(filePath, acc)) {
    testCases.push(rec);
    accumulate(summary, rec);
  }
  return { summary, testCases, startTime: acc.startTime ?? null, endTime: acc.endTime ?? null };
}

module.exports = {
  parseMochawesome,
  streamMochawesome,
  looksLikeMochawesome,
  NotMochawesomeJsonError,
};
