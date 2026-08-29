'use strict';

const XLSX = require('xlsx');

const { emptySummary, normaliseStatus, countStatus } = require('./shared');

const firstDefined = (row, keys) => {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== '') return row[key];
  }
  return undefined;
};

/**
 * Parse the first sheet of an Excel/CSV workbook. Expects a header row with
 * columns like Test Name / Status / Duration / Error (case-sensitive, several
 * aliases accepted).
 * @param {string} filePath
 * @returns {Promise<{ summary: ReturnType<typeof emptySummary>, testCases: object[] }>}
 */
async function parseExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet);

  const summary = emptySummary();
  const testCases = rows.map((row) => {
    const status = normaliseStatus(firstDefined(row, ['Status', 'Result', 'State']));
    const duration = parseFloat(firstDefined(row, ['Duration', 'Time', 'Elapsed'])) || 0;

    summary.total += 1;
    countStatus(summary, status);
    summary.duration += duration;

    return {
      title: firstDefined(row, ['Test Name', 'Name', 'Test', 'Title']) || '',
      status,
      duration,
      errorMessage: firstDefined(row, ['Error', 'Message', 'Failure']) || '',
      errorStack: '',
      file: firstDefined(row, ['File', 'Suite', 'Class']) || null,
      suite: firstDefined(row, ['Suite', 'Module', 'Group']) || null,
    };
  });

  return { summary, testCases };
}

module.exports = { parseExcel };
