'use strict';

const path = require('node:path');

const { parseJUnit } = require('./junit');
const { parseHtml } = require('./html');
const { parseExcel } = require('./excel');
const { emptySummary, normaliseStatus, countStatus } = require('./shared');

/**
 * Return the parser function for a file, based on its extension. Extensionless
 * files are assumed to be JUnit XML (Vitest / Pest often emit these). Returns
 * `null` for unsupported types.
 * @param {string} filePath
 * @returns {((filePath: string) => Promise<object>) | null}
 */
function parserForFile(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.xml':
    case '':
      return parseJUnit;
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

module.exports = {
  parseJUnit,
  parseHtml,
  parseExcel,
  parserForFile,
  emptySummary,
  normaliseStatus,
  countStatus,
};
