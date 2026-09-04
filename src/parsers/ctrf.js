'use strict';

const fs = require('node:fs');

const { stripAnsi, normaliseStatus, countStatus, emptySummary } = require('./shared');
const { clampField } = require('../limits');

/** Error thrown when a `.json` file is valid JSON but not a CTRF report. */
class NotCtrfJsonError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotCtrfJsonError';
    this.skippable = true;
  }
}

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

/** Does this parsed object look like a CTRF (Common Test Report Format) report? */
function looksLikeCtrf(parsed) {
  const results = parsed && parsed.results;
  return Boolean(results && results.tool && Array.isArray(results.tests));
}

/** Epoch-millis (CTRF's convention) or ISO to an ISO string, else null. */
function toIso(value) {
  if (value === undefined || value === null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function buildRecord(test) {
  return {
    title: test.name || '',
    status: normaliseStatus(test.status || 'other'),
    duration: Math.round(Number(test.duration) || 0),
    errorMessage: clampField(stripAnsi(test.message || '')),
    errorStack: clampField(stripAnsi(test.trace || '')),
    file: test.filePath || test.file || null,
    suite: test.suite || null,
    project: test.browser || test.tags?.project || null,
    line: Number(test.line) || null,
    retries: Number(test.retries) || 0,
    flaky: Boolean(test.flaky),
    attachments: asArray(test.screenshot ? [{ name: 'screenshot', path: test.screenshot }] : []),
    stdout: '',
    stderr: '',
  };
}

/**
 * Stream test-case records from a CTRF (Common Test Report Format) JSON
 * report - the cross-runner schema shipped by CTRF reporters for Jest,
 * Playwright, Cypress, k6, and many others (https://ctrf.io).
 * @param {string} filePath
 * @param {{ startTime?: ?string, endTime?: ?string }} [acc]
 * @returns {AsyncGenerator<object>}
 */
async function* streamCtrf(filePath, acc = {}) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new NotCtrfJsonError(`Not valid JSON: ${err.message}`);
  }
  if (!looksLikeCtrf(parsed)) {
    throw new NotCtrfJsonError(
      'JSON file is not a CTRF report (no `results.tool` + `results.tests`)',
    );
  }

  const { tests, summary } = parsed.results;
  for (const test of asArray(tests)) yield buildRecord(test);

  acc.startTime = toIso(summary && summary.start);
  acc.endTime = toIso(summary && summary.stop);
}

/**
 * Buffered convenience wrapper - drains {@link streamCtrf} into an array.
 * @param {string} filePath
 * @returns {Promise<{ summary: object, testCases: object[], startTime: ?string, endTime: ?string }>}
 */
async function parseCtrf(filePath) {
  const acc = {};
  const summary = emptySummary();
  const testCases = [];
  for await (const rec of streamCtrf(filePath, acc)) {
    testCases.push(rec);
    summary.total += 1;
    countStatus(summary, rec.status);
    summary.duration += rec.duration || 0;
  }
  return { summary, testCases, startTime: acc.startTime ?? null, endTime: acc.endTime ?? null };
}

const STATUS_TO_CTRF = { passed: 'passed', failed: 'failed', skipped: 'skipped', flaky: 'passed' };

/**
 * The reverse direction: build a CTRF document from Testrix's internal
 * records, so any format Testrix can read, it can also re-emit as CTRF
 * (`testrix --output ctrf`). CTRF has no "flaky" status of its own - a flaky
 * record (failed then passed) is reported as `passed` with `flaky: true`,
 * matching how CTRF reporters for other tools represent it.
 * @param {{ testCases: object[], summary: object, startTime: ?string, endTime: ?string }} parsed
 * @returns {object}
 */
function toCtrf({ testCases, summary, startTime, endTime }) {
  const start = startTime ? Date.parse(startTime) : undefined;
  const stop = endTime ? Date.parse(endTime) : undefined;
  return {
    results: {
      tool: { name: 'testrix-cli' },
      summary: {
        tests: summary.total,
        passed: summary.passed + summary.flaky,
        failed: summary.failed,
        pending: 0,
        skipped: summary.skipped,
        other: 0,
        start: Number.isFinite(start) ? start : undefined,
        stop: Number.isFinite(stop) ? stop : undefined,
      },
      tests: testCases.map((tc) => ({
        name: tc.title,
        status: STATUS_TO_CTRF[tc.status] || 'other',
        duration: tc.duration,
        suite: tc.suite || undefined,
        filePath: tc.file || undefined,
        line: tc.line || undefined,
        message: tc.errorMessage || undefined,
        trace: tc.errorStack || undefined,
        retries: tc.retries || undefined,
        flaky: tc.flaky || undefined,
      })),
    },
  };
}

module.exports = { parseCtrf, streamCtrf, looksLikeCtrf, toCtrf, NotCtrfJsonError };
