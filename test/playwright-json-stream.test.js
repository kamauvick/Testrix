'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parsePlaywrightJson, streamPlaywrightJson } = require('../src/parsers/playwright-json');

/** Run `fn` with TESTRIX_JSON_STREAM_THRESHOLD_BYTES forced low, then restore it. */
function withLowThreshold(bytes, fn) {
  const saved = process.env.TESTRIX_JSON_STREAM_THRESHOLD_BYTES;
  process.env.TESTRIX_JSON_STREAM_THRESHOLD_BYTES = String(bytes);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env.TESTRIX_JSON_STREAM_THRESHOLD_BYTES;
      else process.env.TESTRIX_JSON_STREAM_THRESHOLD_BYTES = saved;
    });
}

/** A Playwright JSON report with `nSuites` spec files, one test each (one fails). */
function buildReport(nSuites) {
  const suites = [];
  for (let s = 0; s < nSuites; s += 1) {
    const failed = s === 1; // exactly one failure, in the second suite
    suites.push({
      title: `spec-${s}.spec.ts`,
      file: `spec-${s}.spec.ts`,
      specs: [
        {
          title: `case ${s}`,
          line: 1,
          tests: [
            {
              projectId: 'chromium',
              projectName: 'chromium',
              status: failed ? 'unexpected' : 'expected',
              results: [
                {
                  status: failed ? 'failed' : 'passed',
                  duration: 5,
                  retry: 0,
                  attachments: [],
                  ...(failed ? { error: { message: 'boom' } } : {}),
                },
              ],
            },
          ],
        },
      ],
    });
  }
  return {
    config: {},
    suites,
    errors: [],
    stats: { startTime: '2026-09-04T10:00:00.000Z', duration: 500 },
  };
}

const tmpJson = (obj) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testrix-pwjson-'));
  const file = path.join(dir, 'report.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  return { file, dir };
};

test('streamPlaywrightJson: large-report path matches the buffered path', async () => {
  const { file, dir } = tmpJson(buildReport(50));
  try {
    await withLowThreshold(10, async () => {
      const streamedRecords = [];
      const acc = {};
      for await (const rec of streamPlaywrightJson(file, acc)) streamedRecords.push(rec);

      const buffered = await parsePlaywrightJson(file); // same low threshold -> also streams

      assert.equal(streamedRecords.length, 50);
      assert.equal(buffered.summary.total, 50);
      assert.equal(buffered.summary.failed, 1);
      assert.equal(acc.startTime, '2026-09-04T10:00:00.000Z');
      assert.equal(buffered.startTime, '2026-09-04T10:00:00.000Z');
      assert.equal(buffered.endTime, '2026-09-04T10:00:00.500Z');

      const failedRecord = buffered.testCases.find((tc) => tc.status === 'failed');
      assert.equal(failedRecord.suite, 'spec-1.spec.ts');
      assert.equal(failedRecord.file, 'spec-1.spec.ts');
      assert.equal(failedRecord.errorMessage, 'boom');
      assert.equal(failedRecord.project, 'chromium');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('streamPlaywrightJson: large-report path rejects a non-Playwright JSON file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testrix-pwjson-bad-'));
  const file = path.join(dir, 'notes.json');
  fs.writeFileSync(file, JSON.stringify({ hello: 'world', padding: 'x'.repeat(200) }));
  try {
    await withLowThreshold(10, async () => {
      await assert.rejects(
        () => parsePlaywrightJson(file),
        /does not look like a Playwright report/,
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the default threshold keeps small, real-world reports on the JSON.parse fast path', async () => {
  const { file, dir } = tmpJson(buildReport(3));
  try {
    // No threshold override: a few-KB file must not go anywhere near stream-json.
    const { summary } = await parsePlaywrightJson(file);
    assert.equal(summary.total, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
