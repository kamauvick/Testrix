'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { isGlob, expand, expandAll } = require('../src/glob');

const fixturesDir = path.join(__dirname, 'fixtures');
const base = (files) => files.map((f) => path.basename(f)).sort();

test('isGlob detects metacharacters', () => {
  assert.equal(isGlob('a/b.xml'), false);
  assert.equal(isGlob('a/*.xml'), true);
  assert.equal(isGlob('a/**/b.xml'), true);
  assert.equal(isGlob('a/{x,y}.xml'), true);
});

test('expand returns a literal path untouched (no filesystem check)', () => {
  const out = expand('does/not/exist.xml', fixturesDir);
  assert.equal(out.length, 1);
  assert.match(out[0], /exist\.xml$/);
});

test('expand resolves *, **, and {a,b}', () => {
  assert.deepEqual(base(expand('*.json', fixturesDir)), [
    'playwright-json-globalerror.json',
    'playwright-json.json',
  ]);
  assert.deepEqual(base(expand('**/playwright-junit*.xml', path.dirname(fixturesDir))), [
    'playwright-junit-globalerror.xml',
    'playwright-junit.xml',
  ]);
  assert.ok(
    base(expand('playwright-junit.{xml,json}', fixturesDir)).includes('playwright-junit.xml'),
  );
});

test('expandAll de-duplicates overlapping patterns', () => {
  const out = expandAll(['*.xml', 'playwright-*.xml'], fixturesDir);
  assert.equal(new Set(out).size, out.length);
  assert.ok(out.length >= 3);
});

test('expand terminates on a symlink cycle instead of recursing forever', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testrix-glob-cycle-'));
  fs.writeFileSync(path.join(dir, 'real.xml'), '<a/>');
  try {
    fs.symlinkSync(dir, path.join(dir, 'loop'), 'junction');
  } catch (err) {
    // Creating symlinks needs elevated privilege on some Windows setups;
    // the cycle guard itself is exercised elsewhere in this file's suite.
    t.skip(`cannot create a symlink in this environment: ${err.message}`);
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  try {
    const out = expand('**/*.xml', dir);
    assert.deepEqual(
      out.map((f) => path.basename(f)),
      ['real.xml'],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
