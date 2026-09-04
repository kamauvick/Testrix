'use strict';

const fs = require('node:fs');
const { SaxesParser } = require('saxes');

const { stripAnsi, sanitizeXmlChunk, emptySummary, accumulate, makeCase } = require('./shared');
const { clampField } = require('../limits');

const OUTCOME_MAP = { Passed: 'passed', Failed: 'failed', NotExecuted: 'skipped' };

/** `HH:MM:SS.fffffff` (.trx's own format) to whole milliseconds. */
function durationToMs(text) {
  const m = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(String(text || '').trim());
  if (!m) return 0;
  const [, h, min, s, frac = ''] = m;
  const ms = Math.round(Number(`0.${frac || '0'}`) * 1000);
  return (Number(h) * 3600 + Number(min) * 60 + Number(s)) * 1000 + ms;
}

/**
 * Streaming reader for MSTest's `.trx` (`dotnet test --logger trx`). Test
 * identity (class/method name) lives in `<TestDefinitions><UnitTest>`, keyed
 * by id; the actual result is `<Results><UnitTestResult testId>` - and
 * `<Results>` comes *before* `<TestDefinitions>` in a standard .trx file, so
 * results can't be resolved against their definition as they're seen. Both
 * are buffered (each is one small object per test - no worse than the
 * `records` array every parser already builds) and joined once at `end()`.
 */
class TrxSaxReader {
  constructor(fileName) {
    this.records = [];
    this._error = null;
    this._definitions = new Map(); // id -> { className, name }
    this._pendingResults = []; // resolved against _definitions at end()
    this._result = null; // current <UnitTestResult> accumulator
    this._capture = null; // { tag, buf }

    const parser = new SaxesParser({ fileName });
    parser.on('error', (e) => {
      this._error ||= e;
    });
    parser.on('doctype', (dt) => {
      if (/<!ENTITY/i.test(dt)) this._error ||= new Error('.trx report declares DTD entities');
    });
    parser.on('opentag', (node) => this._open(node));
    parser.on('text', (t) => this._text(t));
    parser.on('cdata', (t) => this._text(t));
    parser.on('closetag', (node) => this._close(node.name));
    this._parser = parser;
    this._pendingDefinitionId = null;
  }

  write(chunk) {
    this._parser.write(chunk);
    if (this._error) throw this._error;
  }

  end() {
    this._parser.close();
    if (this._error) throw this._error;

    for (const r of this._pendingResults) {
      const def = (r.testId && this._definitions.get(r.testId)) || null;
      this.records.push(
        makeCase({
          title: (def && def.name) || r.testName,
          status: r.status,
          duration: durationToMs(r.duration),
          file: def && def.className,
          errorMessage: clampField(r.message),
          errorStack: clampField(r.stack),
        }),
      );
    }
    this._pendingResults = [];
  }

  drain() {
    return this.records.splice(0);
  }

  _open(node) {
    const attrs = node.attributes || {};
    switch (node.name) {
      case 'UnitTest':
        this._pendingDefinitionId = attrs.id || null;
        break;
      case 'TestMethod':
        if (this._pendingDefinitionId) {
          this._definitions.set(this._pendingDefinitionId, {
            className: attrs.className || null,
            name: attrs.name || null,
          });
        }
        break;
      case 'UnitTestResult':
        this._result = {
          testId: attrs.testId || null,
          testName: attrs.testName || '',
          duration: attrs.duration || '',
          status: OUTCOME_MAP[attrs.outcome] || (attrs.outcome ? 'failed' : 'passed'),
          message: '',
          stack: '',
        };
        break;
      case 'Message':
      case 'StackTrace':
        if (this._result && !this._capture) this._capture = { tag: node.name, buf: '' };
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
      if (this._result) {
        if (name === 'Message') this._result.message = text;
        else if (name === 'StackTrace') this._result.stack = text;
      }
      this._capture = null;
      return;
    }
    if (name === 'UnitTest') {
      this._pendingDefinitionId = null;
    } else if (name === 'UnitTestResult' && this._result) {
      this._pendingResults.push(this._result);
      this._result = null;
    }
  }
}

/** Stream test-case records from an MSTest `.trx` file. */
async function* streamTrx(filePath, acc = {}) {
  const reader = new TrxSaxReader(filePath);
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

/**
 * Buffered convenience wrapper - drains {@link streamTrx} into an array.
 * @param {string} filePath
 * @returns {Promise<{ summary: object, testCases: object[], startTime: null, endTime: null }>}
 */
async function parseTrx(filePath) {
  const acc = {};
  const summary = emptySummary();
  const testCases = [];
  for await (const rec of streamTrx(filePath, acc)) {
    testCases.push(rec);
    accumulate(summary, rec);
  }
  return { summary, testCases, startTime: acc.startTime, endTime: acc.endTime };
}

module.exports = { parseTrx, streamTrx };
