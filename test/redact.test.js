'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { redactUrl, redactSecrets } = require('../src/redact');

test('redactUrl strips userinfo, leaves clean URLs alone', () => {
  assert.equal(redactUrl('https://user:pw@api.example.com/x'), 'https://api.example.com/x');
  assert.equal(redactUrl('https://api.example.com/x'), 'https://api.example.com/x');
  assert.equal(redactUrl('not a url'), 'not a url');
});

test('redactSecrets replaces every occurrence of a registered secret', () => {
  const out = redactSecrets('key=SUPERSECRET and again SUPERSECRET', new Set(['SUPERSECRET']));
  assert.equal(out, 'key=*** and again ***');
});

test('redactSecrets ignores trivially short values', () => {
  assert.equal(redactSecrets('abc', new Set(['ab'])), 'abc');
});

test('the logger scrubs a registered secret from every level', () => {
  // Fresh module instance so this test owns the secret registry.
  const modPath = require.resolve('../src/logger');
  delete require.cache[modPath];
  const log = require(modPath);

  const lines = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    log.addSecret('tk_live_abcdef123456');
    log.info('publishing with key tk_live_abcdef123456');
    log.error('failed: Bearer tk_live_abcdef123456 rejected');
  } finally {
    console.log = origLog;
    console.error = origErr;
    delete require.cache[modPath];
  }

  assert.ok(
    lines.every((l) => !l.includes('tk_live_abcdef123456')),
    `secret leaked: ${lines.join(' | ')}`,
  );
  assert.ok(lines.some((l) => l.includes('***')));
});
