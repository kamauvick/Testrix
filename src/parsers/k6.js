'use strict';

const fs = require('node:fs');

const { countStatus, emptySummary } = require('./shared');

/**
 * Error thrown when a `.json` file is valid JSON but not a k6 summary export.
 */
class NotK6JsonError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotK6JsonError';
    this.skippable = true;
  }
}

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

/**
 * Does this parsed object look like a k6 `--summary-export` / `handleSummary`
 * report? `root_group` + `metrics` is a combination unique to k6.
 */
function looksLikeK6(parsed) {
  return Boolean(
    parsed && parsed.root_group && parsed.metrics && typeof parsed.metrics === 'object',
  );
}

/**
 * k6 doesn't have "tests" - it has **checks** (assertions made during a load
 * test, e.g. `check(res, {'status is 200': (r) => r.status === 200})`) and,
 * separately, **thresholds** (pass/fail SLAs on a metric, e.g.
 * `p(95)<200`). Both map naturally to pass/fail test cases; the underlying
 * metric values are attached as `metrics` for whoever consumes them next.
 */
function walkGroupChecks(group, parentPath, out) {
  const groupPath = [parentPath, group.name].filter(Boolean).join(' / ');
  for (const check of asArray(group.checks)) {
    const passes = Number(check.passes) || 0;
    const fails = Number(check.fails) || 0;
    out.push({
      title: check.name || '(unnamed check)',
      status: fails > 0 ? 'failed' : passes > 0 ? 'passed' : 'skipped',
      duration: 0,
      errorMessage: fails > 0 ? `${fails} of ${passes + fails} check invocation(s) failed` : '',
      errorStack: '',
      file: null,
      suite: groupPath || null,
      project: null,
      line: null,
      retries: 0,
      flaky: false,
      attachments: [],
      stdout: '',
      stderr: '',
      metrics: [
        { name: 'passes', value: passes, unit: 'count' },
        { name: 'fails', value: fails, unit: 'count' },
      ],
    });
  }
  for (const child of asArray(group.groups)) walkGroupChecks(child, groupPath, out);
}

/** One test case per metric threshold (k6's pass/fail SLAs, e.g. `p(95)<200`). */
function thresholdRecords(metrics) {
  const out = [];
  for (const [metricName, metric] of Object.entries(metrics || {})) {
    const thresholds = metric && metric.thresholds;
    if (!thresholds || typeof thresholds !== 'object') continue;
    for (const [expr, result] of Object.entries(thresholds)) {
      const ok =
        result && (result.ok === true || result.ok === undefined ? result.ok !== false : false);
      out.push({
        title: `${metricName}: ${expr}`,
        status: ok ? 'passed' : 'failed',
        duration: 0,
        errorMessage: ok ? '' : `Threshold "${expr}" on "${metricName}" was not met`,
        errorStack: '',
        file: null,
        suite: 'thresholds',
        project: null,
        line: null,
        retries: 0,
        flaky: false,
        attachments: [],
        stdout: '',
        stderr: '',
        metrics: Object.entries(metric.values || {}).map(([name, value]) => ({
          name: `${metricName}.${name}`,
          value,
          unit: metric.type === 'trend' ? 'ms' : '',
        })),
      });
    }
  }
  return out;
}

/**
 * Stream test-case records from a k6 summary export (`k6 run
 * --summary-export=summary.json`, or the equivalent written by a custom
 * `handleSummary()`). Checks and threshold results become pass/fail cases;
 * the underlying metric values ride along as each record's `metrics`.
 * @param {string} filePath
 * @param {{ startTime?: null, endTime?: null }} [acc]
 * @returns {AsyncGenerator<object>}
 */
async function* streamK6(filePath, acc = {}) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new NotK6JsonError(`Not valid JSON: ${err.message}`);
  }
  if (!looksLikeK6(parsed)) {
    throw new NotK6JsonError('JSON file is not a k6 summary export (no `root_group` + `metrics`)');
  }

  const out = [];
  walkGroupChecks(parsed.root_group, '', out);
  out.push(...thresholdRecords(parsed.metrics));
  yield* out;

  acc.startTime = null; // k6's summary export doesn't carry a wall-clock window
  acc.endTime = null;
}

/**
 * Buffered convenience wrapper - drains {@link streamK6} into an array.
 * @param {string} filePath
 * @returns {Promise<{ summary: object, testCases: object[], startTime: null, endTime: null }>}
 */
async function parseK6(filePath) {
  const acc = {};
  const summary = emptySummary();
  const testCases = [];
  for await (const rec of streamK6(filePath, acc)) {
    testCases.push(rec);
    summary.total += 1;
    countStatus(summary, rec.status);
    summary.duration += rec.duration || 0;
  }
  return { summary, testCases, startTime: acc.startTime, endTime: acc.endTime };
}

module.exports = { parseK6, streamK6, looksLikeK6, NotK6JsonError };
