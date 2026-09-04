'use strict';

const fs = require('node:fs');
const { SaxesParser } = require('saxes');

const {
  stripAnsi,
  sanitizeXmlChunk,
  normaliseStatus,
  emptySummary,
  countStatus,
} = require('./shared');
const { clampField } = require('../limits');

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

const CAPTURE_TAGS = new Set(['message', 'stack-trace', 'output']);

/**
 * Streaming reader for NUnit3's XML report (`--result=TestResult.xml`, the
 * common output for .NET / Selenium-with-NUnit suites). Nested `<test-suite>`
 * elements build the suite path; `<test-case result duration>` are the cases
 * (`duration` is in seconds, like JUnit).
 */
class NUnitSaxReader {
  constructor(fileName) {
    this.records = [];
    this._error = null;
    this._suiteStack = []; // names of ancestor <test-suite>
    this._tc = null; // current <test-case> accumulator
    this._capture = null; // { tag, buf }

    const parser = new SaxesParser({ fileName });
    parser.on('error', (e) => {
      this._error ||= e;
    });
    parser.on('doctype', (dt) => {
      if (/<!ENTITY/i.test(dt)) this._error ||= new Error('NUnit report declares DTD entities');
    });
    parser.on('opentag', (node) => this._open(node));
    parser.on('text', (t) => this._text(t));
    parser.on('cdata', (t) => this._text(t));
    parser.on('closetag', (node) => this._close(node.name));
    this._parser = parser;
  }

  write(chunk) {
    this._parser.write(chunk);
    if (this._error) throw this._error;
  }

  end() {
    this._parser.close();
    if (this._error) throw this._error;
  }

  drain() {
    return this.records.splice(0);
  }

  _open(node) {
    const attrs = node.attributes || {};
    if (node.name === 'test-suite') {
      this._suiteStack.push(attrs.name || '');
      return;
    }
    if (node.name === 'test-case') {
      this._tc = {
        name: attrs.name || attrs.fullname || '',
        classname: attrs.classname || null,
        status: normaliseStatus(attrs.result || 'passed'),
        duration: Math.round((parseFloat(attrs.duration) || 0) * 1000),
        message: '',
        stack: '',
      };
      return;
    }
    if (CAPTURE_TAGS.has(node.name) && this._tc && !this._capture) {
      this._capture = { tag: node.name, buf: '' };
    }
  }

  _text(chunk) {
    if (this._capture) this._capture.buf += chunk;
  }

  _close(name) {
    if (this._capture && this._capture.tag === name) {
      const text = stripAnsi(this._capture.buf.trim());
      if (this._tc) {
        if (name === 'message') this._tc.message = text;
        else if (name === 'stack-trace') this._tc.stack = text;
      }
      this._capture = null;
      return;
    }
    if (name === 'test-case' && this._tc) {
      const tc = this._tc;
      this.records.push(
        makeCase({
          title: tc.name,
          status: tc.status,
          duration: tc.duration,
          file: tc.classname,
          suite: this._suiteStack.filter(Boolean).join(' / ') || null,
          errorMessage: clampField(tc.message),
          errorStack: clampField(tc.stack),
        }),
      );
      this._tc = null;
    } else if (name === 'test-suite') {
      this._suiteStack.pop();
    }
  }
}

/** Stream test-case records from an NUnit3 XML report. */
async function* streamNUnit(filePath, acc = {}) {
  const reader = new NUnitSaxReader(filePath);
  const rs = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of rs) {
      reader.write(sanitizeXmlChunk(chunk));
      for (const rec of reader.drain()) yield rec;
    }
    reader.end();
  } catch (err) {
    rs.destroy();
    throw err;
  }
  for (const rec of reader.drain()) yield rec;
  acc.startTime = null;
  acc.endTime = null;
}

/** Sniff a `.xml` file's first bytes for NUnit3's root element. */
function looksLikeNUnit(head) {
  return /<test-run\b/i.test(head) && !/<testsuite/i.test(head);
}

/**
 * Buffered convenience wrapper - drains {@link streamNUnit} into an array.
 * @param {string} filePath
 * @returns {Promise<{ summary: object, testCases: object[], startTime: null, endTime: null }>}
 */
async function parseNUnit(filePath) {
  const acc = {};
  const summary = emptySummary();
  const testCases = [];
  for await (const rec of streamNUnit(filePath, acc)) {
    testCases.push(rec);
    summary.total += 1;
    countStatus(summary, rec.status);
    summary.duration += rec.duration || 0;
  }
  return { summary, testCases, startTime: acc.startTime, endTime: acc.endTime };
}

module.exports = { parseNUnit, streamNUnit, looksLikeNUnit };
