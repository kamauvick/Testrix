'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SaxesParser } = require('saxes');

const { emptySummary, countStatus, stripAnsi, sanitizeXmlChunk } = require('./shared');
const { clampField } = require('../limits');

// Longest ANSI/control run we might split across a stream chunk boundary.
const CHUNK_CARRY = 24;

const toInt = (value) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
};

// JUnit <testcase time="..."> is in seconds; the pipeline works in milliseconds
// so sub-second durations survive the integer rounding in the payload.
const secondsToMs = (value) => Math.round((parseFloat(value) || 0) * 1000);

/** A test-case record with every field defaulted, so downstream code stays simple. */
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

/** Pull `[[ATTACHMENT|path]]` markers (Playwright) out of <system-out> text. */
function parseAttachments(systemOut) {
  const attachments = [];
  const re = /\[\[ATTACHMENT\|([^\]]+)\]\]/g;
  let match;
  while ((match = re.exec(systemOut)) !== null) {
    const filePath = match[1].trim();
    attachments.push({ name: filePath.split(/[\\/]/).pop(), path: filePath });
  }
  return attachments;
}

const CAPTURE_TAGS = new Set([
  'failure',
  'error',
  'flakyFailure',
  'flakyError',
  'rerunFailure',
  'rerunError',
  'system-out',
  'system-err',
]);

/**
 * A push parser that turns a JUnit XML byte stream into test-case records. It
 * never builds a DOM: at most one <testcase> plus its child text is held in
 * memory at a time, so peak memory is independent of the file size.
 *
 * Feed chunks with `write()`, then call `end()`. Emitted records queue in
 * `records` for the caller to drain. `startTime` / `endTime` describe the run
 * window (from <testsuite timestamp> + time).
 */
class JUnitSaxReader {
  constructor(fileName) {
    this.records = [];
    this.startTime = null;
    this.endTime = null;
    this._emitted = 0;
    this._error = null;
    this._timing = { start: undefined, end: undefined };
    this._suiteStack = []; // [{ name, project }]
    this._rootErrors = 0;
    this._rootFailures = 0;
    this._sawTestsuites = false;
    this._tc = null; // current <testcase> accumulator
    this._suiteErrors = []; // <error> directly under a <testsuite>
    this._capture = null; // { tag, attrs, buf }

    const parser = new SaxesParser({ fileName });
    parser.on('error', (e) => {
      this._error ||= e;
    });
    parser.on('doctype', (dt) => {
      // Neutralise XML entity-expansion attacks (billion laughs): real JUnit
      // reports never carry a DTD with entity definitions.
      if (/<!ENTITY/i.test(dt)) {
        this._error ||= new Error('JUnit report declares DTD entities, which are not supported');
      }
    });
    parser.on('opentag', (node) => this._open(node));
    parser.on('text', (t) => this._text(t));
    parser.on('cdata', (t) => this._text(t));
    parser.on('closetag', (node) => this._close(node));
    this._parser = parser;
  }

  write(chunk) {
    this._parser.write(chunk);
    if (this._error) throw this._error;
  }

  end() {
    this._parser.close();
    if (this._error) throw this._error;
    this.startTime =
      this._timing.start === undefined ? null : new Date(this._timing.start).toISOString();
    this.endTime = this._timing.end === undefined ? null : new Date(this._timing.end).toISOString();

    // A run that crashed in global setup / a worker emits `errors`/`failures`
    // counts but no <testcase>. Surface it so the run is never published green.
    // `_rootErrors` / `_rootFailures` hold the <testsuites> attrs when present,
    // otherwise the sum of the root <testsuite> attrs.
    if (this._emitted === 0) {
      const errors = this._rootErrors;
      const failures = this._rootFailures;
      if (errors + failures > 0) {
        this._push(
          makeCase({
            title: 'Test run error',
            status: 'failed',
            errorMessage:
              `The report declares ${errors} error(s) and ${failures} failure(s) but contains ` +
              'no test cases - the run most likely failed in global setup, a web server, or a worker.',
          }),
        );
      }
    }
  }

  drain() {
    return this.records.splice(0);
  }

  _push(record) {
    this.records.push(record);
    this._emitted += 1;
  }

  _open(node) {
    const name = node.name;
    const attrs = node.attributes || {};

    if (name === 'testsuites') {
      this._sawTestsuites = true;
      this._rootErrors = toInt(attrs.errors);
      this._rootFailures = toInt(attrs.failures);
      return;
    }

    if (name === 'testsuite') {
      if (!this._sawTestsuites) {
        this._rootErrors += toInt(attrs.errors);
        this._rootFailures += toInt(attrs.failures);
      }
      const parentProject = this._suiteStack.length
        ? this._suiteStack[this._suiteStack.length - 1].project
        : null;
      this._suiteStack.push({
        name: attrs.name || '',
        project: attrs.hostname || parentProject || null,
      });
      const started = Date.parse(attrs.timestamp);
      if (Number.isFinite(started)) {
        const ended = started + (parseFloat(attrs.time) || 0) * 1000;
        const t = this._timing;
        t.start = t.start === undefined ? started : Math.min(t.start, started);
        t.end = t.end === undefined ? ended : Math.max(t.end, ended);
      }
      return;
    }

    if (name === 'testcase') {
      this._tc = {
        attrs,
        failure: null,
        error: null,
        skipped: false,
        flaky: [],
        rerun: [],
        systemOut: '',
        systemErr: '',
      };
      return;
    }

    if (name === 'skipped' && this._tc) {
      this._tc.skipped = true;
      return;
    }

    if (CAPTURE_TAGS.has(name) && !this._capture) {
      this._capture = { tag: name, attrs, buf: '' };
    }
  }

  _text(chunk) {
    if (this._capture) this._capture.buf += chunk;
  }

  _close(node) {
    const name = node.name;

    if (this._capture && this._capture.tag === name) {
      this._applyCapture(this._capture);
      this._capture = null;
      return;
    }

    if (name === 'testcase' && this._tc) {
      this._push(this._buildRecord(this._tc));
      this._tc = null;
      return;
    }

    if (name === 'testsuite') {
      const suitePath = this._suitePath();
      const suite = this._suiteStack[this._suiteStack.length - 1];
      for (const err of this._suiteErrors.splice(0)) {
        this._push(
          makeCase({
            title: suite && suite.name ? `${suite.name} (suite error)` : 'Test suite error',
            status: 'failed',
            project: suite ? suite.project : null,
            suite: suitePath,
            errorMessage: clampField(
              err.message || 'Test suite reported an error with no test cases',
            ),
            errorStack: clampField(err.body),
          }),
        );
      }
      this._suiteStack.pop();
    }
  }

  _applyCapture(cap) {
    const detail = {
      message: cap.attrs && cap.attrs.message ? stripAnsi(cap.attrs.message) : '',
      body: stripAnsi(cap.buf.trim()),
    };
    const tc = this._tc;
    switch (cap.tag) {
      case 'failure':
        if (tc) tc.failure = detail;
        break;
      case 'error':
        if (tc) tc.error = detail;
        else this._suiteErrors.push(detail);
        break;
      case 'flakyFailure':
      case 'flakyError':
        if (tc) tc.flaky.push(detail);
        break;
      case 'rerunFailure':
      case 'rerunError':
        if (tc) tc.rerun.push(detail);
        break;
      case 'system-out':
        if (tc) tc.systemOut += cap.buf;
        break;
      case 'system-err':
        if (tc) tc.systemErr += cap.buf;
        break;
      default:
        break;
    }
  }

  _suitePath() {
    const names = this._suiteStack.map((s) => s.name).filter(Boolean);
    return names.length ? names.join(' / ') : null;
  }

  _buildRecord(tc) {
    const attrs = tc.attrs || {};
    const project = this._suiteStack.length
      ? this._suiteStack[this._suiteStack.length - 1].project
      : null;

    const flakyDetected = tc.flaky.length > 0 && !tc.failure && !tc.error;
    let status = 'passed';
    if (tc.skipped) status = 'skipped';
    else if (tc.failure || tc.error) status = 'failed';
    if (flakyDetected) status = 'flaky';

    let detail = { message: '', body: '' };
    if (status === 'failed') detail = tc.failure || tc.error || detail;
    else if (status === 'flaky') detail = tc.flaky[0] || detail;

    const systemOut = tc.systemOut.trim();
    const systemErr = stripAnsi(tc.systemErr.trim());
    let stack = detail.body;
    if (status === 'failed' && !detail.message && !stack && systemErr) stack = systemErr;

    let title = attrs.name || '';
    if (project && title.startsWith(`[${project}] `)) title = title.slice(project.length + 3);

    return makeCase({
      title,
      status,
      duration: secondsToMs(attrs.time),
      project,
      file: attrs.file || attrs.class || attrs.classname || null,
      suite: this._suitePath(),
      line: toInt(attrs.line) || null,
      retries: tc.flaky.length + tc.rerun.length,
      flaky: status === 'flaky',
      attachments: parseAttachments(systemOut),
      stdout: clampField(stripAnsi(systemOut)),
      stderr: clampField(systemErr),
      errorMessage: clampField(detail.message),
      errorStack: clampField(stack),
    });
  }
}

/**
 * Stream test-case records from a JUnit XML file. Vitest, Pest / PHPUnit nested
 * trees, and Playwright (project via `hostname`, retries, `[[ATTACHMENT]]`
 * markers, crashed-run detection) are all handled.
 * @param {string} filePath
 * @param {{ startTime?: ?string, endTime?: ?string }} [acc] filled with the run window
 * @returns {AsyncGenerator<object>}
 */
async function* streamJUnit(filePath, acc = {}) {
  const reader = new JUnitSaxReader(path.basename(filePath));
  const rs = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  let carry = '';
  try {
    for await (const chunk of rs) {
      const combined = carry + chunk;
      // Hold back a short tail so an ANSI/control run split across the boundary
      // is still sanitised as one piece on the next iteration.
      carry = combined.slice(-CHUNK_CARRY);
      reader.write(sanitizeXmlChunk(combined.slice(0, -CHUNK_CARRY)));
      for (const rec of reader.drain()) yield rec;
    }
    reader.write(sanitizeXmlChunk(carry));
    reader.end();
  } catch (err) {
    rs.destroy();
    throw err;
  }
  for (const rec of reader.drain()) yield rec;
  acc.startTime = reader.startTime;
  acc.endTime = reader.endTime;
}

/**
 * Buffered convenience wrapper - drains {@link streamJUnit} into an array.
 * @param {string} filePath
 * @returns {Promise<{ summary: object, testCases: object[], startTime: ?string, endTime: ?string }>}
 */
async function parseJUnit(filePath) {
  const acc = {};
  const summary = emptySummary();
  const testCases = [];
  for await (const rec of streamJUnit(filePath, acc)) {
    testCases.push(rec);
    summary.total += 1;
    countStatus(summary, rec.status);
    summary.duration += rec.duration || 0;
  }
  return { summary, testCases, startTime: acc.startTime ?? null, endTime: acc.endTime ?? null };
}

module.exports = { parseJUnit, streamJUnit };
