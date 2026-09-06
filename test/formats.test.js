'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseTestNG } = require('../src/parsers/testng');
const { parseNUnit } = require('../src/parsers/nunit');
const { parseMochawesome, NotMochawesomeJsonError } = require('../src/parsers/mochawesome');
const { parseCtrf, NotCtrfJsonError } = require('../src/parsers/ctrf');
const { parseK6, NotK6JsonError } = require('../src/parsers/k6');
const { parseTap } = require('../src/parsers/tap');
const { parseJMeter } = require('../src/parsers/jmeter');
const { parseTrx } = require('../src/parsers/trx');

const fixture = (name) => path.join(__dirname, 'fixtures', name);

test('parseTestNG reads pass/fail/skip, excludes @Before/@After config methods', async () => {
  const { summary, testCases } = await parseTestNG(fixture('testng-results.xml'));

  assert.equal(summary.total, 3); // the is-config="true" setUp() is excluded
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);

  const failed = testCases.find((tc) => tc.status === 'failed');
  assert.equal(failed.title, 'loginFailsWithBadPassword');
  assert.equal(failed.suite, 'Regression / LoginTests');
  assert.equal(failed.file, 'com.example.LoginTest');
  assert.equal(failed.errorMessage, 'expected [true] but found [false]');
  assert.match(failed.errorStack, /AssertionError/);
});

test('parseNUnit reads pass/fail/skip with a nested suite path and ms durations', async () => {
  const { summary, testCases } = await parseNUnit(fixture('nunit3-results.xml'));

  assert.equal(summary.total, 3);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);

  const failed = testCases.find((tc) => tc.status === 'failed');
  assert.equal(failed.suite, 'Tests.dll / LoginTests');
  assert.equal(failed.duration, 12, 'seconds converted to milliseconds');
  assert.equal(failed.errorMessage, 'Expected: True But was: False');
});

test('parseMochawesome reads Cypress-style nested suites and err.estack', async () => {
  const { summary, testCases, startTime, endTime } = await parseMochawesome(
    fixture('mochawesome.json'),
  );

  assert.equal(summary.total, 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(startTime, '2026-09-04T10:00:00.000Z');
  assert.equal(endTime, '2026-09-04T10:00:01.500Z');

  const failed = testCases.find((tc) => tc.status === 'failed');
  assert.equal(failed.suite, 'Login');
  assert.equal(failed.file, 'cypress/e2e/login.cy.js');
  assert.match(failed.errorStack, /AssertionError/);

  await assert.rejects(
    () => parseMochawesome(fixture('ctrf-report.json')),
    NotMochawesomeJsonError,
  );
});

test('parseCtrf reads the common cross-runner schema, including flaky/retries', async () => {
  const { summary, testCases, startTime, endTime } = await parseCtrf(fixture('ctrf-report.json'));

  assert.equal(summary.total, 3);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(startTime, new Date(1798000000000).toISOString());
  assert.equal(endTime, new Date(1798000005000).toISOString());

  const failed = testCases.find((tc) => tc.status === 'failed');
  assert.equal(failed.retries, 1);
  assert.equal(failed.flaky, true);
  assert.equal(failed.suite, 'math');
  assert.equal(failed.line, 12);

  await assert.rejects(() => parseCtrf(fixture('mochawesome.json')), NotCtrfJsonError);
});

test('parseK6 turns checks and threshold results into pass/fail cases with metrics', async () => {
  const { summary, testCases } = await parseK6(fixture('k6-summary.json'));

  // 1 root check + 1 grouped check + 2 thresholds = 4 cases
  assert.equal(summary.total, 4);

  const rootCheck = testCases.find((tc) => tc.title === 'status is 200' && tc.suite === null);
  assert.equal(rootCheck.status, 'passed');

  const groupedCheck = testCases.find((tc) => tc.suite === 'checkout flow');
  assert.equal(groupedCheck.status, 'failed');
  assert.match(groupedCheck.errorMessage, /2 of 100/);

  const metThreshold = testCases.find((tc) => tc.title === 'http_req_duration: p(95)<300');
  assert.equal(metThreshold.status, 'passed');
  const missedThreshold = testCases.find((tc) => tc.title === 'http_req_duration: p(95)<200');
  assert.equal(missedThreshold.status, 'failed');
  assert.ok(missedThreshold.metrics.some((m) => m.name === 'http_req_duration.p(95)'));

  await assert.rejects(() => parseK6(fixture('ctrf-report.json')), NotK6JsonError);
});

test('parseTap reads ok/not ok lines and the YAML diagnostic block', async () => {
  const { summary, testCases } = await parseTap(fixture('sample.tap'));

  assert.equal(summary.total, 3);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);

  const failed = testCases.find((tc) => tc.status === 'failed');
  assert.equal(failed.title, 'subtracts numbers');
  assert.equal(failed.duration, 1); // duration_ms: 0.5 rounds to 1
  assert.equal(failed.errorMessage, 'expected 1 to be 2');
  assert.match(failed.errorStack, /test\.js:12:5/);

  const skipped = testCases.find((tc) => tc.status === 'skipped');
  assert.equal(skipped.title, 'skipped case');
});

test('parseJMeter aggregates CSV .jtl samples by label', async () => {
  const { summary, testCases } = await parseJMeter(fixture('jmeter-results.csv'));

  assert.equal(summary.total, 2); // 4 samples, 2 unique labels

  const home = testCases.find((tc) => tc.title === 'Home Page');
  assert.equal(home.status, 'passed');
  assert.equal(home.duration, Math.round((120 + 95) / 2));

  const checkout = testCases.find((tc) => tc.title === 'Checkout');
  assert.equal(checkout.status, 'failed');
  assert.match(checkout.errorMessage, /1 of 2 sample/);
  assert.ok(checkout.metrics.find((m) => m.name === 'error_rate').value > 0);
});

test('parseJMeter aggregates XML .jtl samples the same way, using nested failureMessage', async () => {
  const { summary, testCases } = await parseJMeter(fixture('jmeter-results.xml'));

  assert.equal(summary.total, 2);
  const checkout = testCases.find((tc) => tc.title === 'Checkout');
  assert.equal(checkout.status, 'failed');
  assert.match(checkout.errorMessage, /expected 200 got 500/);
});

test('parseTrx joins <Results> against <TestDefinitions> (which appears after it)', async () => {
  const { summary, testCases } = await parseTrx(fixture('mstest-results.trx'));

  assert.equal(summary.total, 3);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);

  const failed = testCases.find((tc) => tc.status === 'failed');
  assert.equal(failed.title, 'LoginFailsWithBadPassword');
  assert.equal(failed.file, 'NS.LoginTests'); // resolved from TestDefinitions by testId
  assert.equal(failed.duration, 12); // 00:00:00.0120000 -> 12ms
  assert.equal(failed.errorMessage, 'Assert.IsTrue failed.');
});
