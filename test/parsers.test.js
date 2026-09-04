'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  parseJUnit,
  parsePlaywrightJson,
  parserForFile,
  normaliseStatus,
  stripAnsi,
} = require('../src/parsers');
const { resolveConfig, DEFAULT_API_URL } = require('../src/config');
const { buildPayload, parseReports } = require('../src/publisher');

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
  assert.equal(parserForFile('report.json'), parsePlaywrightJson);
  assert.equal(parserForFile('report.html').name, 'parseHtml');
  assert.equal(parserForFile('report.xlsx').name, 'parseExcel');
  assert.equal(parserForFile('notes.txt'), null);
});

test('stripAnsi removes colour codes; normaliseStatus maps Playwright vocab', () => {
  const ESC = String.fromCharCode(27);
  assert.equal(stripAnsi(`${ESC}[31mred${ESC}[39m text`), 'red text');
  assert.equal(normaliseStatus('expected'), 'passed');
  assert.equal(normaliseStatus('unexpected'), 'failed');
  assert.equal(normaliseStatus('timedOut'), 'failed');
  assert.equal(normaliseStatus('interrupted'), 'failed');
  assert.equal(normaliseStatus('flaky'), 'flaky');
});

test('parseJUnit reads a Playwright report: project, flaky, attachments, ANSI', async () => {
  const { summary, testCases } = await parseJUnit(fixture('playwright-junit.xml'));

  assert.equal(summary.total, 5);
  assert.equal(summary.passed, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.flaky, 1);

  const failed = testCases.find((tc) => tc.status === 'failed');
  assert.equal(failed.project, 'chromium');
  assert.equal(failed.errorMessage, 'Error: expect(received).toBeVisible()');
  assert.ok(!failed.errorStack.includes(String.fromCharCode(27)), 'ANSI stripped from stack');
  assert.deepEqual(
    failed.attachments.map((a) => a.path),
    [
      'test-results/login-bad-password-chromium/test-failed-1.png',
      'test-results/login-bad-password-chromium/trace.zip',
    ],
  );

  const flaky = testCases.find((tc) => tc.status === 'flaky');
  assert.equal(flaky.flaky, true);
  assert.equal(flaky.retries, 1);
  assert.equal(flaky.duration, 3000, 'seconds converted to milliseconds');

  const firefox = testCases.find((tc) => tc.project === 'firefox');
  assert.equal(firefox.status, 'passed');
});

test('parseJUnit derives the run window from <testsuite timestamp> + time', async () => {
  const { startTime, endTime } = await parseJUnit(fixture('playwright-junit.xml'));
  assert.equal(startTime, '2026-09-04T10:00:00.000Z');
  // chromium suite: 10:00:00 + 7.845s is the latest end across both suites
  assert.equal(endTime, '2026-09-04T10:00:07.845Z');
});

test('parsePlaywrightJson derives the run window from stats.startTime + duration', async () => {
  const { startTime, endTime } = await parsePlaywrightJson(fixture('playwright-json.json'));
  assert.equal(startTime, '2026-09-04T10:00:00.000Z');
  assert.equal(endTime, '2026-09-04T10:00:06.000Z');
});

test('parseJUnit turns an unattributed error report into a failed case (no false green)', async () => {
  const { summary, testCases } = await parseJUnit(fixture('playwright-junit-globalerror.xml'));

  assert.equal(summary.total, 1);
  assert.equal(summary.failed, 1);
  assert.equal(testCases[0].status, 'failed');
  assert.match(testCases[0].errorMessage, /no test cases/);
});

test('parsePlaywrightJson walks suites/specs/tests with ms durations and retries', async () => {
  const { summary, testCases } = await parsePlaywrightJson(fixture('playwright-json.json'));

  assert.equal(summary.total, 4);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.flaky, 1);

  const failed = testCases.find((tc) => tc.status === 'failed');
  assert.equal(failed.suite, 'tests/login.spec.ts / error handling');
  assert.equal(failed.line, 12);
  assert.ok(!failed.errorMessage.includes(String.fromCharCode(27)), 'ANSI stripped');
  assert.equal(failed.attachments[0].contentType, 'image/png');

  const flaky = testCases.find((tc) => tc.status === 'flaky');
  assert.equal(flaky.retries, 1);
  assert.equal(flaky.duration, 1200, 'takes the final attempt duration, in ms');
});

test('parsePlaywrightJson surfaces top-level errors and rejects non-Playwright JSON', async () => {
  const { summary } = await parsePlaywrightJson(fixture('playwright-json-globalerror.json'));
  assert.equal(summary.failed, 1);

  await assert.rejects(
    () => parsePlaywrightJson(fixture('../../package.json')),
    /not a Playwright report/,
  );
});

test('parseReports skips a stray non-Playwright JSON file instead of aborting', async () => {
  const { summary } = await parseReports([
    fixture('playwright-json.json'),
    fixture('../../package.json'),
  ]);
  assert.equal(summary.total, 4);
});

test('parseHtml rejects a Playwright HTML report with an actionable message', async () => {
  const { parseHtml } = require('../src/parsers');
  await assert.rejects(
    () => parseHtml(fixture('playwright-html-report.html')),
    /Playwright HTML report/,
  );
});

test('buildPayload prefixes the project only when a run spans several projects', () => {
  const multi = buildPayload(
    { userId: 'u1', projectId: 'p1' },
    {
      testCases: [
        { title: 'a', status: 'passed', duration: 1, suite: 'spec.ts', project: 'chromium' },
        { title: 'a', status: 'passed', duration: 1, suite: 'spec.ts', project: 'firefox' },
      ],
      suites: ['spec.ts'],
    },
  );
  assert.equal(multi.testCases[0].suite, '[chromium] spec.ts');

  const single = buildPayload(
    { userId: 'u1', projectId: 'p1' },
    {
      testCases: [
        { title: 'a', status: 'passed', duration: 1, suite: 'spec.ts', project: 'chromium' },
      ],
      suites: ['spec.ts'],
    },
  );
  assert.equal(single.testCases[0].suite, 'spec.ts');
});

test('buildPayload passes through flaky status, retryCount and artifact paths', () => {
  const payload = buildPayload(
    { userId: 'u1', projectId: 'p1' },
    {
      testCases: [
        {
          title: 'retried',
          status: 'flaky',
          duration: 10,
          retries: 2,
          attachments: [
            { name: 'screenshot', contentType: 'image/png', path: 's.png' },
            { name: 'trace', contentType: 'application/zip', path: 't.zip' },
          ],
        },
      ],
      suites: [],
    },
  );
  const tc = payload.testCases[0];
  assert.equal(tc.status, 'flaky');
  assert.equal(tc.retryCount, 2);
  assert.equal(tc.screenshot, 's.png');
  assert.equal(tc.trace, 't.zip');
});

test('buildPayload uses the parsed run window unless config overrides it', () => {
  const args = {
    testCases: [{ title: 'a', status: 'passed', duration: 1 }],
    suites: [],
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2026-01-01T00:05:00.000Z',
  };
  const derived = buildPayload({ userId: 'u', projectId: 'p' }, args);
  assert.equal(derived.testRun.startTime, '2026-01-01T00:00:00.000Z');
  assert.equal(derived.testRun.endTime, '2026-01-01T00:05:00.000Z');

  const pinned = buildPayload(
    { userId: 'u', projectId: 'p', startTime: '2020-01-01T00:00:00.000Z' },
    args,
  );
  assert.equal(pinned.testRun.startTime, '2020-01-01T00:00:00.000Z');
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
