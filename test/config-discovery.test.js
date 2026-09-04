'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findConfigFile } = require('../src/config-discovery');
const { loadConfig } = require('../src/config');

const mktmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'testrix-cfgdisc-'));

test('findConfigFile prefers testrix.config.json over .testrixrc and package.json#testrix', () => {
  const dir = mktmp();
  try {
    fs.writeFileSync(path.join(dir, '.testrixrc'), JSON.stringify({ projectId: 'from-rc' }));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ testrix: { projectId: 'from-pkg' } }),
    );
    fs.writeFileSync(
      path.join(dir, 'testrix.config.json'),
      JSON.stringify({ projectId: 'from-json' }),
    );
    const found = findConfigFile(dir);
    assert.equal(found.config.projectId, 'from-json');
    assert.match(found.path, /testrix\.config\.json$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findConfigFile falls back to .testrixrc, then package.json#testrix', () => {
  const dirA = mktmp();
  try {
    fs.writeFileSync(path.join(dirA, '.testrixrc'), JSON.stringify({ projectId: 'from-rc' }));
    assert.equal(findConfigFile(dirA).config.projectId, 'from-rc');
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
  }

  const dirB = mktmp();
  try {
    fs.writeFileSync(
      path.join(dirB, 'package.json'),
      JSON.stringify({ name: 'x', testrix: { projectId: 'from-pkg' } }),
    );
    const found = findConfigFile(dirB);
    assert.equal(found.config.projectId, 'from-pkg');
    assert.match(found.path, /package\.json#testrix$/);
  } finally {
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('findConfigFile walks up from a subdirectory', () => {
  const dir = mktmp();
  try {
    fs.writeFileSync(
      path.join(dir, 'testrix.config.json'),
      JSON.stringify({ projectId: 'from-root' }),
    );
    const sub = path.join(dir, 'a', 'b', 'c');
    fs.mkdirSync(sub, { recursive: true });
    assert.equal(findConfigFile(sub).config.projectId, 'from-root');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findConfigFile loads a .cjs config file as a module', () => {
  const dir = mktmp();
  try {
    fs.writeFileSync(
      path.join(dir, 'testrix.config.cjs'),
      "module.exports = { projectId: 'from-cjs' };\n",
    );
    assert.equal(findConfigFile(dir).config.projectId, 'from-cjs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findConfigFile returns null (not config.json) when nothing matches', () => {
  const dir = mktmp();
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ projectId: 'legacy' }));
    // config.json is a cwd-only fallback handled by loadConfig, not by findConfigFile.
    assert.equal(findConfigFile(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig(undefined, ...) uses testrix.config.json when cwd has one', () => {
  const dir = mktmp();
  const cwd = process.cwd();
  try {
    fs.writeFileSync(
      path.join(dir, 'testrix.config.json'),
      JSON.stringify({ projectId: 'p-from-file', apiKey: 'k-from-file' }),
    );
    process.chdir(dir);
    const config = loadConfig(undefined, {});
    assert.equal(config.projectId, 'p-from-file');
    assert.equal(config.apiKey, 'k-from-file');
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig(undefined, ...) falls back to ./config.json when no new-style file exists', () => {
  const dir = mktmp();
  const cwd = process.cwd();
  try {
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ projectId: 'p-legacy', apiKey: 'k-legacy' }),
    );
    process.chdir(dir);
    const config = loadConfig(undefined, {});
    assert.equal(config.projectId, 'p-legacy');
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
