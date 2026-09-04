'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');

const { submitReport, deriveRunUrl, backoffMs, proxyDispatcher } = require('../src/http');

/** Like `serve`, but hands the handler the raw request body Buffer (for gzip). */
function serveRaw(onRequest) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => onRequest(req, res, Buffer.concat(chunks)));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/submit` });
    });
  });
}

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

test('submitReport follows a same-origin 307 redirect, preserving the POST body', async () => {
  let sawFinalBody = null;
  const { server, url } = await serve((req, res, body) => {
    if (req.url === '/old') {
      res.writeHead(307, { Location: '/new' });
      res.end();
      return;
    }
    sawFinalBody = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ testRunId: 'r1' }));
  });
  try {
    const oldUrl = url.replace(/\/[^/]*$/, '/old');
    const out = await submitReport({ serverApiUrl: oldUrl, apiKey: 'k' }, { testCases: [1] });
    assert.equal(out.testRunId, 'r1');
    assert.deepEqual(sawFinalBody, { testCases: [1] });
  } finally {
    server.close();
  }
});

test('submitReport refuses a cross-origin redirect rather than following it', async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(307, { Location: 'https://attacker.example.com/steal' });
    res.end();
  });
  try {
    await assert.rejects(
      () => submitReport({ serverApiUrl: url, apiKey: 'super-secret-key' }, { testCases: [] }),
      /cross-origin/,
    );
  } finally {
    server.close();
  }
});

test('submitReport refuses a 302 redirect (would silently drop the body)', async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(302, { Location: '/elsewhere' });
    res.end();
  });
  try {
    await assert.rejects(
      () => submitReport({ serverApiUrl: url, apiKey: 'k' }, { testCases: [] }),
      /drop the request body/,
    );
  } finally {
    server.close();
  }
});

test('proxyDispatcher: picks HTTPS_PROXY, honours NO_PROXY, off by default', () => {
  const saved = {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY,
  };
  try {
    delete process.env.HTTPS_PROXY;
    delete process.env.NO_PROXY;
    assert.equal(proxyDispatcher(new URL('https://api.example.com')), undefined);

    process.env.HTTPS_PROXY = 'http://proxy.local:8080';
    assert.ok(proxyDispatcher(new URL('https://api.example.com')));

    process.env.NO_PROXY = 'example.com';
    assert.equal(proxyDispatcher(new URL('https://api.example.com')), undefined);
    assert.equal(proxyDispatcher(new URL('https://sub.example.com')), undefined);
    assert.ok(proxyDispatcher(new URL('https://other.test')));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('submitReport: --gzip compresses the body and sets Content-Encoding', async () => {
  let seenHeader;
  let seenBody;
  const { server, url } = await serveRaw((req, res, raw) => {
    seenHeader = req.headers['content-encoding'];
    seenBody = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ testRunId: 'r' }));
  });
  try {
    const out = await submitReport(
      { serverApiUrl: url, apiKey: 'k' },
      { testCases: [{ title: 'a' }] },
      { gzip: true },
    );
    assert.equal(out.testRunId, 'r');
    assert.equal(seenHeader, 'gzip');
    assert.deepEqual(seenBody, { testCases: [{ title: 'a' }] });
  } finally {
    server.close();
  }
});

test('submitReport: an oversized body is rejected locally, before any request is sent', async () => {
  let hits = 0;
  const { server, url } = await serve((req, res) => {
    hits += 1;
    res.writeHead(200);
    res.end('{}');
  });
  try {
    const bigPayload = { testCases: [{ title: 'x'.repeat(1000) }] };
    await assert.rejects(
      () => submitReport({ serverApiUrl: url, apiKey: 'k' }, bigPayload, { maxUploadBytes: 100 }),
      /over the configured/,
    );
    assert.equal(hits, 0, 'no request should have been made');
  } finally {
    server.close();
  }
});
