'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { submitReport, deriveRunUrl, backoffMs } = require('../src/http');

/** Start a throwaway HTTP server whose handler is `onRequest`. */
function serve(onRequest) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => onRequest(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/submit` });
    });
  });
}

test('backoffMs: positive default, honours numeric Retry-After, ignores a null/empty header', () => {
  assert.ok(backoffMs(1, null) >= 500, 'no header -> exponential base, not zero');
  assert.ok(backoffMs(1, '') >= 500, 'empty header -> exponential base, not zero');
  assert.equal(backoffMs(1, '2'), 2000, 'Retry-After seconds honoured');
  assert.equal(backoffMs(3, null, 0), 0, 'override wins');
});

test('deriveRunUrl: explicit dashboardUrl wins', () => {
  assert.equal(
    deriveRunUrl('https://x-api.example.com/api/x', 'run-1', 'https://dash.example.com/'),
    'https://dash.example.com/test-runs/run-1',
  );
});

test('deriveRunUrl: derives the web host from an "-api" API host', () => {
  assert.equal(
    deriveRunUrl('https://testing-dashboard-api.myworkpay.com/api/submit-test-reports', 'r7'),
    'https://testing-dashboard.myworkpay.com/test-runs/r7',
  );
});

test('deriveRunUrl: undefined when the host is ambiguous or the id is missing', () => {
  assert.equal(deriveRunUrl('https://dashboard.example.com/api/x', 'r1'), undefined);
  assert.equal(deriveRunUrl('https://x-api.example.com/api/x', undefined), undefined);
});

test('submitReport sends auth, User-Agent and Idempotency-Key headers', async () => {
  const seen = {};
  const { server, url } = await serve((req, res, body) => {
    Object.assign(seen, { headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ testRunId: 'abc123' }));
  });
  try {
    const out = await submitReport({ serverApiUrl: url, apiKey: 'k-1' }, { testCases: [] });
    assert.equal(out.testRunId, 'abc123');
    assert.equal(seen.headers['x-api-key'], 'k-1');
    assert.match(seen.headers['user-agent'], /^testrix-cli\//);
    assert.ok(seen.headers['idempotency-key']);
  } finally {
    server.close();
  }
});

test('submitReport retries transient 503s then succeeds', async () => {
  let hits = 0;
  const { server, url } = await serve((req, res) => {
    hits += 1;
    if (hits < 3) {
      res.writeHead(503);
      res.end('busy');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ testRunId: 'r' }));
    }
  });
  try {
    const out = await submitReport(
      { serverApiUrl: url, apiKey: 'k' },
      { testCases: [] },
      { retries: 4, retryDelayMs: 0 },
    );
    assert.equal(out.testRunId, 'r');
    assert.equal(hits, 3);
  } finally {
    server.close();
  }
});

test('submitReport gives up on a 4xx without retrying', async () => {
  let hits = 0;
  const { server, url } = await serve((req, res) => {
    hits += 1;
    res.writeHead(401);
    res.end('nope');
  });
  try {
    await assert.rejects(
      () => submitReport({ serverApiUrl: url, apiKey: 'bad' }, { testCases: [] }, { retries: 4 }),
      /401/,
    );
    assert.equal(hits, 1);
  } finally {
    server.close();
  }
});
