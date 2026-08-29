'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseJUnit, parserForFile } = require('../src/parsers');
const { resolveConfig, DEFAULT_API_URL } = require('../src/config');
const { buildPayload } = require('../src/publisher');

const fixture = (name) => path.join(__dirname, 'fixtures', name);

test('parseJUnit reads a flat vitest report', async () => {
  const { summary, testCases } = await parseJUnit(fixture('vitest-junit.xml'));

  assert.equal(summary.total, 3);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);

  const failed = testCases.find((tc) => tc.status === 'failed');
  assert.equal(failed.title, 'subtracts numbers');
  assert.equal(failed.errorMessage, 'expected 1 to be 2');
  assert.match(failed.errorStack, /AssertionError/);
  assert.equal(failed.suite, 'src/math.test.ts');
});

test('parseJUnit flattens nested Pest/PHPUnit suites into a suite path', async () => {
  const { summary, testCases } = await parseJUnit(fixture('pest-junit.xml'));

  assert.equal(summary.total, 2);
  assert.equal(summary.failed, 1);
  assert.equal(testCases[0].suite, 'Unit / Tests\\Unit\\ExampleTest');
  assert.equal(testCases[0].file, 'tests/Unit/ExampleTest.php');
});

test('parserForFile maps extensions (and extensionless files to JUnit)', () => {
  assert.equal(parserForFile('report.xml'), parseJUnit);
  assert.equal(parserForFile('frontend-junit'), parseJUnit);
  assert.equal(parserForFile('report.html').name, 'parseHtml');
  assert.equal(parserForFile('report.xlsx').name, 'parseExcel');
  assert.equal(parserForFile('notes.txt'), null);
});

test('resolveConfig applies env fallbacks and the default API url', () => {
  process.env.TESTRIX_PROJECT_ID = 'proj-from-env';
  process.env.TESTRIX_API_KEY = 'key-from-env';
  const config = resolveConfig({ userId: 'u1', reportsDir: './reports' });
  assert.equal(config.projectId, 'proj-from-env');
  assert.equal(config.apiKey, 'key-from-env');
  assert.equal(config.serverApiUrl, DEFAULT_API_URL);
  delete process.env.TESTRIX_PROJECT_ID;
  delete process.env.TESTRIX_API_KEY;
});

test('resolveConfig rejects missing required keys and bad urls', () => {
  assert.throws(() => resolveConfig({ userId: 'u1' }), /Missing required config/);
  assert.throws(
    () =>
      resolveConfig({
        userId: 'u1',
        projectId: 'p',
        apiKey: 'k',
        reportsDir: '.',
        serverApiUrl: 'not-a-url',
      }),
    /not a valid URL/,
  );
});

test('buildPayload normalises test cases and names the run from suites', () => {
  const config = { userId: 'u1', projectId: 'p1', includeSuitesInPayload: true };
  const payload = buildPayload(config, {
    testCases: [{ title: 'a', status: 'passed', duration: 12.7 }],
    suites: ['Checkout', 'Cart'],
  });
  assert.equal(payload.testRun.name, 'Checkout, Cart');
  assert.deepEqual(payload.testRun.suites, ['Checkout', 'Cart']);
  assert.equal(payload.testCases[0].duration, 13);
  assert.equal(payload.testCases[0].errorMessage, '');
});
