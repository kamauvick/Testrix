'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const { SaxesParser } = require('saxes');

const { emptySummary, countStatus } = require('./shared');
const { clampField } = require('../limits');

/**
 * Aggregates JMeter samples by `label` (transaction/request name) rather than
 * keeping every sample: memory is O(unique labels), not O(sample count), which
 * matters because `.jtl` files are routinely gigabytes with millions of rows.
 */
class LabelAggregator {
  constructor() {
    this.order = [];
    this.byLabel = new Map();
  }

  add(label, elapsedMs, success, failureMessage, timestampMs) {
    const key = label || '(unlabelled)';
    let agg = this.byLabel.get(key);
    if (!agg) {
      agg = {
        count: 0,
        failures: 0,
        sum: 0,
        min: Infinity,
        max: 0,
        firstFailure: '',
        start: null,
        end: null,
      };
      this.byLabel.set(key, agg);
      this.order.push(key);
    }
    agg.count += 1;
    if (!success) {
      agg.failures += 1;
      if (!agg.firstFailure && failureMessage) agg.firstFailure = failureMessage;
    }
    const ms = Number(elapsedMs) || 0;
    agg.sum += ms;
    if (ms < agg.min) agg.min = ms;
    if (ms > agg.max) agg.max = ms;
    if (Number.isFinite(timestampMs)) {
      if (agg.start === null || timestampMs < agg.start) agg.start = timestampMs;
      if (agg.end === null || timestampMs > agg.end) agg.end = timestampMs;
    }
  }

  /** One test case per label: failed if any sample failed, duration = mean elapsed. */
  *records() {
    for (const label of this.order) {
      const agg = this.byLabel.get(label);
      const avg = agg.count > 0 ? agg.sum / agg.count : 0;
      yield {
        title: label,
        status: agg.failures > 0 ? 'failed' : 'passed',
        duration: Math.round(avg),
        errorMessage: clampField(
          agg.failures > 0
            ? `${agg.failures} of ${agg.count} sample(s) failed` +
                (agg.firstFailure ? `: ${agg.firstFailure}` : '')
            : '',
        ),
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
        metrics: [
          { name: 'samples', value: agg.count, unit: 'count' },
          { name: 'errors', value: agg.failures, unit: 'count' },
          { name: 'error_rate', value: agg.count ? agg.failures / agg.count : 0, unit: 'ratio' },
          { name: 'avg', value: Math.round(avg), unit: 'ms' },
          { name: 'min', value: agg.min === Infinity ? 0 : agg.min, unit: 'ms' },
          { name: 'max', value: agg.max, unit: 'ms' },
        ],
      };
    }
  }

  window() {
    let start = null;
    let end = null;
    for (const agg of this.byLabel.values()) {
      if (agg.start !== null && (start === null || agg.start < start)) start = agg.start;
      if (agg.end !== null && (end === null || agg.end > end)) end = agg.end;
    }
    return {
      startTime: start === null ? null : new Date(start).toISOString(),
      endTime: end === null ? null : new Date(end).toISOString(),
    };
  }
}

/** Split one CSV line into fields, honouring double-quoted fields (no embedded newlines). */
function splitCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

/** Stream a JMeter CSV `.jtl` file, aggregating by label as it goes. */
async function* streamJMeterCsv(filePath, acc) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  const agg = new LabelAggregator();
  let columns = null;

  for await (const line of rl) {
    if (!line.trim()) continue;
    const fields = splitCsvLine(line);
    if (!columns) {
      columns = fields.map((f) => f.trim());
      if (!columns.includes('label') || !columns.includes('elapsed')) {
        const err = new Error(
          'CSV .jtl file is missing the expected `label`/`elapsed` header columns',
        );
        err.skippable = true;
        throw err;
      }
      continue;
    }
    const row = Object.fromEntries(columns.map((name, i) => [name, fields[i]]));
    agg.add(
      row.label,
      row.elapsed,
      String(row.success).toLowerCase() !== 'false',
      row.failureMessage,
      Number(row.timeStamp),
    );
  }

  if (!columns) {
    const err = new Error('CSV .jtl file is empty');
    err.skippable = true;
    throw err;
  }
  yield* agg.records();
  Object.assign(acc, agg.window());
}

const SAMPLE_TAGS = new Set(['httpSample', 'sample']);

/**
 * Stream an XML `.jtl` file (<httpSample>/<sample> elements, each optionally
 * carrying a nested <assertionResult><failureMessage>), aggregating by label.
 */
async function* streamJMeterXml(filePath, acc) {
  const agg = new LabelAggregator();
  let error = null;
  let current = null; // the open <httpSample>/<sample>'s attributes + collected failureMessage
  let captureFailureMessage = false;

  const parser = new SaxesParser();
  parser.on('error', (e) => {
    error ||= e;
  });
  parser.on('opentag', (node) => {
    if (SAMPLE_TAGS.has(node.name)) {
      current = { attrs: node.attributes || {}, failureMessage: '' };
    } else if (node.name === 'failureMessage' && current) {
      captureFailureMessage = true;
    }
  });
  parser.on('text', (t) => {
    if (captureFailureMessage && current) current.failureMessage += t;
  });
  parser.on('cdata', (t) => {
    if (captureFailureMessage && current) current.failureMessage += t;
  });
  parser.on('closetag', (node) => {
    if (node.name === 'failureMessage') {
      captureFailureMessage = false;
    } else if (SAMPLE_TAGS.has(node.name) && current) {
      const a = current.attrs;
      agg.add(a.lb, a.t, a.s !== 'false', current.failureMessage.trim() || a.rm, Number(a.ts));
      current = null;
    }
  });

  const rs = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of rs) {
      parser.write(chunk);
      if (error) throw error;
    }
    parser.close();
    if (error) throw error;
  } catch (err) {
    rs.destroy();
    throw err;
  }

  yield* agg.records();
  Object.assign(acc, agg.window());
}

/** Peek at a `.jtl` file's first non-whitespace bytes to tell XML from CSV. */
function sniffJtlIsXml(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return /^\s*<\?xml|^\s*<testResults/i.test(buf.toString('utf8', 0, n));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Stream test-case records from a JMeter `.jtl` results file, in either the
 * CSV or the XML flavour. One record per unique sampler `label`
 * (transaction/request name), aggregated - `.jtl` files routinely run to
 * gigabytes, so per-sample records would defeat the point of streaming.
 * @param {string} filePath
 * @param {{ startTime?: ?string, endTime?: ?string }} [acc]
 * @returns {AsyncGenerator<object>}
 */
function streamJMeter(filePath, acc = {}) {
  return sniffJtlIsXml(filePath) ? streamJMeterXml(filePath, acc) : streamJMeterCsv(filePath, acc);
}

/**
 * Buffered convenience wrapper - drains {@link streamJMeter} into an array.
 * @param {string} filePath
 * @returns {Promise<{ summary: object, testCases: object[], startTime: ?string, endTime: ?string }>}
 */
async function parseJMeter(filePath) {
  const acc = {};
  const summary = emptySummary();
  const testCases = [];
  for await (const rec of streamJMeter(filePath, acc)) {
    testCases.push(rec);
    summary.total += 1;
    countStatus(summary, rec.status);
    summary.duration += rec.duration || 0;
  }
  return { summary, testCases, startTime: acc.startTime ?? null, endTime: acc.endTime ?? null };
}

module.exports = { parseJMeter, streamJMeter };
