'use strict';

const fs = require('node:fs');
const readline = require('node:readline');

const { stripAnsi, emptySummary, countStatus } = require('./shared');
const { clampField } = require('../limits');

const TEST_LINE = /^(not )?ok\b\s*(\d+)?\s*-?\s*(.*)$/;
const DIRECTIVE = /#\s*(SKIP|TODO)\b\s*(.*)$/i;
const YAML_KV = /^(\w[\w-]*)\s*:\s?(.*)$/;

/** A test-case record with every field defaulted. */
function makeCase(partial) {
  return {
    title: '',
    status: 'passed',
    duration: 0,
    errorMessage: '',
    errorStack: '',
    file: null,
    suite: null,
    project: null,
    line: null,
    retries: 0,
    flaky: false,
    attachments: [],
    stdout: '',
    stderr: '',
    ...partial,
  };
}

/** Does the first non-empty line look like a TAP stream? */
function looksLikeTap(firstLine) {
  return (
    /^TAP version\b/i.test(firstLine) ||
    /^(not )?ok\b/.test(firstLine) ||
    /^1\.\.\d+$/.test(firstLine)
  );
}

/**
 * Stream test-case records from a TAP (Test Anything Protocol) stream, as
 * produced by `node --test`, the `tap` package, `pytest-tap`, and others.
 * Parses the `ok` / `not ok` result lines and the common `key: value`
 * diagnostic block a failing line carries between `---` and `...` (this is a
 * pragmatic subset of the YAML block, not a full YAML parser).
 * @param {string} filePath
 * @param {{ startTime?: null, endTime?: null }} [acc]
 * @returns {AsyncGenerator<object>}
 */
async function* streamTap(filePath, acc = {}) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let sawAnyLine = false;
  let checkedFormat = false;
  let pending = null; // { title, status, diagnostics: {} } awaiting its YAML block
  let inBlock = false;
  let subtestTitle = null; // most recent "# Subtest: <name>" line, used as a suite name

  const flush = function* () {
    if (!pending) return;
    const { title, status, diag } = pending;
    const message = diag.error || diag.message || '';
    const stack = diag.stack || '';
    yield makeCase({
      title,
      status,
      duration: Math.round(Number(diag.duration_ms) || 0),
      suite: subtestTitle,
      errorMessage: clampField(stripAnsi(String(message))),
      errorStack: clampField(stripAnsi(String(stack))),
    });
    pending = null;
  };

  for await (const rawLine of rl) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed) continue;
    sawAnyLine = true;
    if (!checkedFormat) {
      checkedFormat = true;
      if (!looksLikeTap(trimmed)) {
        const err = new Error(
          'File does not look like a TAP stream (no TAP version / ok / plan line)',
        );
        err.skippable = true;
        throw err;
      }
    }

    if (inBlock) {
      if (trimmed === '...') {
        inBlock = false;
        continue;
      }
      const kv = trimmed.match(YAML_KV);
      if (kv && pending) pending.diag[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '');
      continue;
    }

    if (trimmed === '---') {
      inBlock = true;
      continue;
    }

    const subtestMatch = trimmed.match(/^#\s*Subtest:\s*(.+)$/i);
    if (subtestMatch) {
      yield* flush();
      subtestTitle = subtestMatch[1].trim();
      continue;
    }

    const match = trimmed.match(TEST_LINE);
    if (!match) continue; // TAP version / plan / comment / unrecognised line
    yield* flush();

    const [, notOk, , rest] = match;
    const directive = rest.match(DIRECTIVE);
    const title = (directive ? rest.slice(0, directive.index) : rest).trim() || '(unnamed test)';
    let status = notOk ? 'failed' : 'passed';
    if (directive && /SKIP/i.test(directive[1])) status = 'skipped';
    pending = { title, status, diag: {} };
  }
  yield* flush();

  if (!sawAnyLine) {
    const err = new Error('Empty file - not a TAP stream');
    err.skippable = true;
    throw err;
  }
  acc.startTime = null;
  acc.endTime = null;
}

/**
 * Buffered convenience wrapper - drains {@link streamTap} into an array.
 * @param {string} filePath
 * @returns {Promise<{ summary: object, testCases: object[], startTime: null, endTime: null }>}
 */
async function parseTap(filePath) {
  const acc = {};
  const summary = emptySummary();
  const testCases = [];
  for await (const rec of streamTap(filePath, acc)) {
    testCases.push(rec);
    summary.total += 1;
    countStatus(summary, rec.status);
    summary.duration += rec.duration || 0;
  }
  return { summary, testCases, startTime: acc.startTime, endTime: acc.endTime };
}

module.exports = { parseTap, streamTap, looksLikeTap };
