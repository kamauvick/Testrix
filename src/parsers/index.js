'use strict';

const path = require('node:path');

const { parseJUnit, streamJUnit } = require('./junit');
const { parseHtml } = require('./html');
const { parseExcel } = require('./excel');
const { parsePlaywrightJson, NotPlaywrightJsonError } = require('./playwright-json');
const { emptySummary, normaliseStatus, countStatus, stripAnsi, SUMMARY_KEYS } = require('./shared');

/**
 * Return the buffered parser for a file, by extension. Extensionless files are
 * assumed to be JUnit XML (Vitest / Pest often emit these); `.json` is a
 * Playwright JSON report. Returns `null` for unsupported types.
 * @param {string} filePath
 * @returns {((filePath: string) => Promise<object>) | null}
 */
function parserForFile(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.xml':
    case '':
      return parseJUnit;
    case '.json':
      return parsePlaywrightJson;
    case '.html':
    case '.htm':
      return parseHtml;
    case '.xls':
    case '.xlsx':
      return parseExcel;
    default:
      return null;
  }
}

/** Adapt a buffered parser to the streaming contract used by `parseReports`. */
function bufferedToStream(parseFn) {
  return async function* (filePath, acc = {}) {
    const result = await parseFn(filePath);
    acc.startTime = result.startTime ?? null;
    acc.endTime = result.endTime ?? null;
    yield* result.testCases;
  };
}

/**
 * Return a `(filePath, acc) => AsyncGenerator<record>` for a file. JUnit is
 * parsed with a true streaming reader (constant memory); other formats are
 * adapted from their buffered parsers. `null` for unsupported types.
 */
function streamParserForFile(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.xml':
    case '':
      return streamJUnit;
    case '.json':
      return bufferedToStream(parsePlaywrightJson);
    case '.html':
    case '.htm':
      return bufferedToStream(parseHtml);
    case '.xls':
    case '.xlsx':
      return bufferedToStream(parseExcel);
    default:
      return null;
  }
}

module.exports = {
  parseJUnit,
  streamJUnit,
  parseHtml,
  parseExcel,
  parsePlaywrightJson,
  NotPlaywrightJsonError,
  parserForFile,
  streamParserForFile,
  emptySummary,
  normaliseStatus,
  countStatus,
  stripAnsi,
  SUMMARY_KEYS,
};
