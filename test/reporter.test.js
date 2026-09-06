'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createReporter } = require('../src/reporter');

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/api/submit` }),
    );
  });
}

test('createReporter emits discover/parse/upload events and resolves with timings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testrix-reporter-'));
  fs.mkdirSync(path.join(dir, 'test-results'));
  fs.copyFileSync(
    path.join(__dirname, 'fixtures', 'vitest-junit.xml'),
    path.join(dir, 'test-results', 'results.xml'),
  );
  const cwd = process.cwd();
  const { server, url } = await serve((req, res, body) => {
    JSON.parse(body); // sanity: valid JSON was sent
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ testRunId: 'run-1' }));
  });

  try {
    process.chdir(dir);
    const events = [];
    const reporter = createReporter({
      userId: 'u',
      projectId: 'p',
      apiKey: 'k',
      serverApiUrl: url,
    });
    reporter
      .on('discover', (d) => events.push(['discover', d]))
      .on('parse', (d) => events.push(['parse', d]))
      .on('upload:start', (d) => events.push(['upload:start', d]))
      .on('upload:done', (d) => events.push(['upload:done', d]));

    const result = await reporter.run();

    assert.equal(result.testRunId, 'run-1');
    assert.equal(result.summary.total, 3);
    assert.ok(result.timings.discoverMs >= 0);
    assert.ok(result.timings.uploadMs >= 0);

    const names = events.map(([name]) => name);
    assert.deepEqual(names, ['discover', 'parse', 'upload:start', 'upload:done']);
    assert.equal(events[1][1].summary.total, 3);
    assert.equal(events[3][1].testRunId, 'run-1');
  } finally {
    process.chdir(cwd);
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createReporter emits a "done" event instead of upload events on --dry-run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testrix-reporter-dry-'));
  fs.mkdirSync(path.join(dir, 'test-results'));
  fs.copyFileSync(
    path.join(__dirname, 'fixtures', 'vitest-junit.xml'),
    path.join(dir, 'test-results', 'results.xml'),
  );
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const events = [];
    const reporter = createReporter({ userId: 'u', projectId: 'p', apiKey: 'k' });
    reporter
      .on('done', (d) => events.push(d))
      .on('upload:start', () => events.push('SHOULD_NOT_FIRE'));

    const result = await reporter.run({ dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].dryRun, true);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
