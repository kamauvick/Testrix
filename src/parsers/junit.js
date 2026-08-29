'use strict';

const fs = require('node:fs');
const xml2js = require('xml2js');

const { emptySummary, countStatus } = require('./shared');

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

/**
 * Extract `{ message, stack }` from a JUnit <failure> / <error> node, tolerating
 * the many shapes xml2js produces (string, object, array of either).
 */
function extractFailureDetails(node) {
  if (!node) return { message: '', stack: '' };
  const first = Array.isArray(node) ? node[0] : node;
  if (typeof first === 'string') return { message: '', stack: first };
  const message = first.$ && first.$.message ? String(first.$.message) : '';
  const stack = first._ ? String(first._) : '';
  return { message, stack };
}

function testStatus(test) {
  if (test.skipped) return 'skipped';
  if (test.failure || test.error) return 'failed';
  return 'passed';
}

/**
 * Recursively walk a <testsuite>, collecting test cases. Nested suites
 * (PHPUnit / Pest) contribute their names to a `A / B / C` suite path.
 */
function walkSuite(suite, parentNames, summary, testCases) {
  const attrs = suite.$ || {};
  const names = attrs.name ? [...parentNames, attrs.name] : parentNames;

  for (const test of asArray(suite.testcase)) {
    const testAttrs = test.$ || {};
    const status = testStatus(test);
    const duration = parseFloat(testAttrs.time || 0) || 0;
    const { message, stack } =
      status === 'failed'
        ? extractFailureDetails(test.failure || test.error)
        : { message: '', stack: '' };

    testCases.push({
      title: testAttrs.name || '',
      status,
      duration,
      errorMessage: message,
      errorStack: stack,
      file: testAttrs.file || testAttrs.class || testAttrs.classname || null,
      suite: names.length > 0 ? names.join(' / ') : null,
    });

    summary.total += 1;
    countStatus(summary, status);
    summary.duration += duration;
  }

  for (const child of asArray(suite.testsuite)) {
    walkSuite(child, names, summary, testCases);
  }
}

function rootSuitesOf(parsed) {
  if (parsed.testsuites) {
    const ts = parsed.testsuites;
    return asArray(ts.testsuite || ts);
  }
  if (parsed.testsuite) return [parsed.testsuite];
  return [];
}

/**
 * Parse a JUnit XML file (Vitest, Pest / PHPUnit, and nested <testsuite> trees).
 * @param {string} filePath
 * @returns {Promise<{ summary: ReturnType<typeof emptySummary>, testCases: object[] }>}
 */
async function parseJUnit(filePath) {
  const xml = fs.readFileSync(filePath, 'utf8');
  const parsed = await new xml2js.Parser().parseStringPromise(xml);

  const summary = emptySummary();
  const testCases = [];
  for (const suite of rootSuitesOf(parsed)) {
    walkSuite(suite, [], summary, testCases);
  }
  return { summary, testCases };
}

module.exports = { parseJUnit };
