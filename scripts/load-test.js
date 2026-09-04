#!/usr/bin/env node
'use strict';

/**
 * Generates large synthetic reports and streams them through the real parsers,
 * asserting a peak-RSS budget. Not part of `npm test` (it takes tens of seconds
 * and several hundred MB of scratch disk) - run it directly or via the
 * `load-test` CI workflow: `node --expose-gc scripts/load-test.js`.
 *
 * TODO.md E1 / E6: "a nightly job that parses a generated 1M-case fixture and
 * asserts a peak-RSS budget."
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { streamJUnit } = require('../src/parsers/junit');
const { streamPlaywrightJson } = require('../src/parsers/playwright-json');

const CASES = Number(process.env.LOAD_TEST_CASES || 1_000_000);
const RSS_BUDGET_MB = Number(process.env.LOAD_TEST_RSS_BUDGET_MB || 700);

function writeJUnit(file, n) {
  const ws = fs.createWriteStream(file);
  const write = (s) => new Promise((res) => (ws.write(s) ? res() : ws.once('drain', res)));
  return (async () => {
    await write(`<?xml version="1.0"?>\n<testsuites tests="${n}">\n`);
    await write(
      `<testsuite name="load.spec.ts" timestamp="${new Date().toISOString()}" time="1" tests="${n}">\n`,
    );
    const failureBody = 'Error: assertion failed\n'.repeat(15);
    for (let i = 0; i < n; i += 1) {
      const body =
        i % 11 === 0
          ? `<testcase name="c${i}" classname="load" time="0.01"><failure message="boom ${i}">${failureBody}</failure></testcase>\n`
          : `<testcase name="c${i}" classname="load" time="0.01"/>\n`;
      await write(body);
    }
    await write('</testsuite>\n</testsuites>\n');
    await new Promise((res) => ws.end(res));
  })();
}

function writePlaywrightJson(file, n) {
  const suites = [];
  for (let i = 0; i < n; i += 1) {
    suites.push({
      title: `spec-${i}.spec.ts`,
      file: `spec-${i}.spec.ts`,
      specs: [
        {
          title: `case ${i}`,
          line: 1,
          tests: [
            {
              projectId: 'chromium',
              projectName: 'chromium',
              status: i % 11 === 0 ? 'unexpected' : 'expected',
              results: [
                {
                  status: i % 11 === 0 ? 'failed' : 'passed',
                  duration: 5,
                  retry: 0,
                  attachments: [],
                  ...(i % 11 === 0 ? { error: { message: 'boom' } } : {}),
                },
              ],
            },
          ],
        },
      ],
    });
  }
  const report = {
    config: {},
    suites,
    errors: [],
    stats: { startTime: new Date().toISOString(), duration: 1000 },
  };
  fs.writeFileSync(file, JSON.stringify(report));
}

function peakRssTracker() {
  let peak = process.memoryUsage().rss;
  return {
    sample: () => {
      const r = process.memoryUsage().rss;
      if (r > peak) peak = r;
    },
    peakMb: () => Math.round(peak / 1e6),
  };
}

async function timeAndBudget(label, run) {
  if (global.gc) global.gc();
  const start = Date.now();
  const tracker = peakRssTracker();
  const count = await run(tracker);
  const ms = Date.now() - start;
  const peakMb = tracker.peakMb();
  const ok = peakMb <= RSS_BUDGET_MB;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: ${count.toLocaleString()} records in ${ms}ms, ` +
      `peak RSS ${peakMb}MB (budget ${RSS_BUDGET_MB}MB)`,
  );
  return ok;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testrix-load-'));
  let allOk = true;
  try {
    const junitFile = path.join(dir, 'load.xml');
    await writeJUnit(junitFile, CASES);
    console.log(`JUnit fixture: ${(fs.statSync(junitFile).size / 1e6).toFixed(0)}MB`);
    allOk =
      (await timeAndBudget('JUnit stream', async (tracker) => {
        let count = 0;
        for await (const _rec of streamJUnit(junitFile, {})) {
          count += 1;
          if (count % 50_000 === 0) tracker.sample();
        }
        return count;
      })) && allOk;

    const jsonCases = Math.min(CASES, 200_000); // JSON streaming is heavier per-record; keep the run short
    const jsonFile = path.join(dir, 'load.json');
    writePlaywrightJson(jsonFile, jsonCases);
    console.log(`Playwright JSON fixture: ${(fs.statSync(jsonFile).size / 1e6).toFixed(0)}MB`);
    process.env.TESTRIX_JSON_STREAM_THRESHOLD_BYTES = '1000000'; // force the streaming path
    allOk =
      (await timeAndBudget('Playwright JSON stream', async (tracker) => {
        let count = 0;
        for await (const _rec of streamPlaywrightJson(jsonFile, {})) {
          count += 1;
          if (count % 20_000 === 0) tracker.sample();
        }
        return count;
      })) && allOk;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
