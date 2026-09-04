'use strict';

const path = require('node:path');

const { parseJUnit, streamJUnit } = require('./junit');
const { parseHtml } = require('./html');
const { parseExcel } = require('./excel');
const {
  parsePlaywrightJson,
  streamPlaywrightJson,
  NotPlaywrightJsonError,
} = require('./playwright-json');
const { parseTestNG, streamTestNG } = require('./testng');
const { parseNUnit, streamNUnit } = require('./nunit');
const { parseMochawesome, streamMochawesome, NotMochawesomeJsonError } = require('./mochawesome');
const { parseCtrf, streamCtrf, NotCtrfJsonError } = require('./ctrf');
const { parseK6, streamK6, NotK6JsonError } = require('./k6');
const { parseTap, streamTap } = require('./tap');
const { parseJMeter, streamJMeter } = require('./jmeter');
const { sniffXmlFormat, sniffJsonFormat } = require('./sniff');
const { emptySummary, normaliseStatus, countStatus, stripAnsi, SUMMARY_KEYS } = require('./shared');

const XML_PARSERS = { junit: parseJUnit, testng: parseTestNG, nunit: parseNUnit };
const XML_STREAMERS = { junit: streamJUnit, testng: streamTestNG, nunit: streamNUnit };
const JSON_PARSERS = {
  playwright: parsePlaywrightJson,
  k6: parseK6,
  ctrf: parseCtrf,
  mochawesome: parseMochawesome,
};
const JSON_STREAMERS = {
  playwright: streamPlaywrightJson,
  k6: streamK6,
  ctrf: streamCtrf,
  mochawesome: streamMochawesome,
};

/**
 * Return the buffered parser for a file. `.xml` / extensionless is sniffed
 * between JUnit / TestNG / NUnit3 by root element; `.json` between Playwright /
 * k6 / CTRF / Mochawesome by top-level keys. Dedicated extensions (`.jtl`,
 * `.tap`, `.html`, `.xls(x)`) map directly. `null` for unsupported types.
 * @param {string} filePath
 * @returns {((filePath: string) => Promise<object>) | null}
 */
function parserForFile(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.xml':
    case '':
      return XML_PARSERS[sniffXmlFormat(filePath)];
    case '.json':
      return JSON_PARSERS[sniffJsonFormat(filePath)];
    case '.jtl':
      return parseJMeter;
    case '.tap':
      return parseTap;
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
 * Return a `(filePath, acc) => AsyncGenerator<record>` for a file - the
 * streaming counterpart of {@link parserForFile}. JUnit, TestNG, NUnit,
 * Playwright JSON, k6, CTRF, Mochawesome, TAP and JMeter all stream natively;
 * HTML/Excel are adapted from their buffered parsers. `null` for unsupported
 * types.
 */
function streamParserForFile(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.xml':
    case '':
      return XML_STREAMERS[sniffXmlFormat(filePath)];
    case '.json':
      return JSON_STREAMERS[sniffJsonFormat(filePath)];
    case '.jtl':
      return streamJMeter;
    case '.tap':
      return streamTap;
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
  streamPlaywrightJson,
  NotPlaywrightJsonError,
  parseTestNG,
  streamTestNG,
  parseNUnit,
  streamNUnit,
  parseMochawesome,
  streamMochawesome,
  NotMochawesomeJsonError,
  parseCtrf,
  streamCtrf,
  NotCtrfJsonError,
  parseK6,
  streamK6,
  NotK6JsonError,
  parseTap,
  streamTap,
  parseJMeter,
  streamJMeter,
  parserForFile,
  streamParserForFile,
  emptySummary,
  normaliseStatus,
  countStatus,
  stripAnsi,
  SUMMARY_KEYS,
};
