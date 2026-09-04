'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'cli.js');
const FIXTURES = path.join(__dirname, 'fixtures');

/** Run the CLI in `cwd` with `args`; resolves with { code, stdout, stderr }. */
function runCli(args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env: { ...process.env, TESTRIX_LOG_LEVEL: 'error', ...env } },
      (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, stdout, stderr }),
    );
  });
}

/** A temp dir containing `test-results/results.xml` copied from a fixture. */
function tmpWithReport(fixtureName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testrix-cli-'));
  fs.mkdirSync(path.join(dir, 'test-results'));
  fs.copyFileSync(path.join(FIXTURES, fixtureName), path.join(dir, 'test-results', 'results.xml'));
  return dir;
}

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/api/submit-test-reports` }),
    );
  });
}

test('--dry-run --output json prints a machine-readable result on stdout', async () => {
  const dir = tmpWithReport('playwright-junit.xml');
  try {
    const { code, stdout } = await runCli(
      ['--project', 'p', '--api-key', 'k', '--dry-run', '--output', 'json'],
      { cwd: dir },
    );
    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.summary.total, 5);
    assert.equal(result.summary.failed, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--fail-on-failed exits 3 when a test failed', async () => {
  const dir = tmpWithReport('playwright-junit.xml');
  try {
    const { code } = await runCli(
      ['--project', 'p', '--api-key', 'k', '--dry-run', '--fail-on-failed'],
      { cwd: dir },
    );
    assert.equal(code, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--fail-on-empty exits 2 when nothing parsed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testrix-cli-empty-'));
  fs.mkdirSync(path.join(dir, 'test-results'));
  fs.writeFileSync(
    path.join(dir, 'test-results', 'results.xml'),
    '<testsuites tests="0"></testsuites>',
  );
  try {
    const { code } = await runCli(
      ['--project', 'p', '--api-key', 'k', '--dry-run', '--fail-on-empty'],
      { cwd: dir },
    );
    assert.equal(code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a real publish posts the payload and reports the run id via --output json', async () => {
  const dir = tmpWithReport('playwright-junit.xml');
  const received = [];
  const { server, url } = await serve((req, res, body) => {
    received.push({ headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ testRunId: 'run-42' }));
  });
  try {
    const { code, stdout } = await runCli(
      ['--project', 'p', '--api-key', 'secret', '--url', url, '--output', 'json'],
      { cwd: dir },
    );
    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.testRunId, 'run-42');
    assert.equal(result.published, 5);
    assert.equal(received.length, 1);
    assert.equal(received[0].headers['x-api-key'], 'secret');
    assert.ok(received[0].body.testRun.startTime.startsWith('2026-09-04T10:00:00'));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown option fails fast with exit 1', async () => {
  const { code, stderr } = await runCli(['--bogus']);
  assert.equal(code, 1);
  assert.match(stderr, /Unknown option: --bogus/);
});

test('--log-format json emits parseable JSON log lines', async () => {
  const dir = tmpWithReport('playwright-junit.xml');
  try {
    const { code, stdout, stderr } = await runCli(
      ['--project', 'p', '--api-key', 'k', '--dry-run', '--log-format', 'json'],
      { cwd: dir, env: { TESTRIX_LOG_LEVEL: 'info' } },
    );
    assert.equal(code, 0);
    const lines = (stdout + stderr).trim().split('\n').filter(Boolean);
    assert.ok(lines.length > 0);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.ok(parsed.level && parsed.msg && parsed.ts);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--debug-bundle writes a redacted JSON snapshot of the run', async () => {
  const dir = tmpWithReport('playwright-junit.xml');
  const bundlePath = path.join(dir, 'bundle.json');
  try {
    const { code } = await runCli(
      ['--project', 'p', '--api-key', 'super-secret', '--dry-run', '--debug-bundle', bundlePath],
      { cwd: dir },
    );
    assert.equal(code, 0);
    const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
    assert.equal(bundle.config.apiKey, '***');
    assert.equal(bundle.summary.total, 5);
    assert.equal(bundle.files.length, 1);
    assert.ok(bundle.timings.parseMs >= 0);
    assert.ok(!JSON.stringify(bundle).includes('super-secret'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
