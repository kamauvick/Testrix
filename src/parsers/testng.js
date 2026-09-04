'use strict';

const fs = require('node:fs');
const { SaxesParser } = require('saxes');

const {
  stripAnsi,
  sanitizeXmlChunk,
  normaliseStatus,
  emptySummary,
  accumulate,
  makeCase,
} = require('./shared');
const { clampField } = require('../limits');

/**
 * Streaming reader for TestNG's `testng-results.xml` (Selenium-via-TestNG,
 * WebdriverIO's TestNG reporter). `<suite>` and `<test>` build the suite path;
 * `<class name>` is the file/class; `is-config="true"` methods (@BeforeMethod
 * etc.) are configuration, not tests, and are excluded.
 */
class TestNGSaxReader {
  constructor(fileName) {
    this.records = [];
    this._error = null;
    this._suite = null;
    this._test = null;
    this._className = null;
    this._method = null; // current <test-method> accumulator
    this._capture = null; // { tag, buf }

    const parser = new SaxesParser({ fileName });
    parser.on('error', (e) => {
      this._error ||= e;
    });
    parser.on('doctype', (dt) => {
      if (/<!ENTITY/i.test(dt)) this._error ||= new Error('TestNG report declares DTD entities');
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
    switch (node.name) {
      case 'suite':
        this._suite = attrs.name || null;
        break;
      case 'test':
        this._test = attrs.name || null;
        break;
      case 'class':
        this._className = attrs.name || null;
        break;
      case 'test-method':
        if (attrs['is-config'] === 'true') {
          this._method = null; // configuration method (@Before/@After*) - not a test
          break;
        }
        this._method = {
          name: attrs.name || attrs.signature || '',
          status: normaliseStatus(attrs.status || 'passed'),
          durationMs: Number(attrs['duration-ms']) || 0,
          message: '',
          stack: '',
        };
        break;
      case 'message':
      case 'full-stacktrace':
        if (this._method) this._capture = { tag: node.name, buf: '' };
        break;
      default:
        break;
    }
  }

  _text(chunk) {
    if (this._capture) this._capture.buf += chunk;
  }

  _close(name) {
    if (this._capture && this._capture.tag === name) {
      const text = stripAnsi(this._capture.buf.trim());
      if (this._method) {
        if (name === 'message' && !this._method.message) this._method.message = text;
        else if (name === 'full-stacktrace') this._method.stack = text;
      }
      this._capture = null;
      return;
    }
    if (name === 'test-method' && this._method) {
      const m = this._method;
      const suitePath = [this._suite, this._test].filter(Boolean).join(' / ') || null;
      this.records.push(
        makeCase({
          title: m.name,
          status: m.status,
          duration: m.durationMs,
          file: this._className,
          suite: suitePath,
          errorMessage: clampField(m.message),
          errorStack: clampField(m.stack),
        }),
      );
      this._method = null;
    } else if (name === 'class') {
      this._className = null;
    } else if (name === 'test') {
      this._test = null;
    } else if (name === 'suite') {
      this._suite = null;
    }
  }
}

/** Stream test-case records from a TestNG `testng-results.xml` file. */
async function* streamTestNG(filePath, acc = {}) {
  const reader = new TestNGSaxReader(filePath);
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
  acc.startTime = null; // TestNG's started-at/finished-at are per-suite, not summarised here
  acc.endTime = null;
}

/** Sniff a `.xml` file's first bytes for the TestNG root element. */
function looksLikeTestNG(head) {
  return /<testng-results\b/i.test(head);
}

/**
 * Buffered convenience wrapper - drains {@link streamTestNG} into an array.
 * @param {string} filePath
 * @returns {Promise<{ summary: object, testCases: object[], startTime: null, endTime: null }>}
 */
async function parseTestNG(filePath) {
  const acc = {};
  const summary = emptySummary();
  const testCases = [];
  for await (const rec of streamTestNG(filePath, acc)) {
    testCases.push(rec);
    accumulate(summary, rec);
  }
  return { summary, testCases, startTime: acc.startTime, endTime: acc.endTime };
}

module.exports = { parseTestNG, streamTestNG, looksLikeTestNG };
