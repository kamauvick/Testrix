'use strict';

// `xlsx` is heavy and only needed for `.xls`/`.xlsx` reports - load it lazily so
// the common JUnit / Playwright path never pays for it.
const { emptySummary, normaliseStatus, countStatus, stripAnsi } = require('./shared');
const { clampField } = require('../limits');

/** A test case object with every field defaulted. */
const makeCase = (partial) => ({
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
});

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
  let XLSX;
  try {
    // `xlsx` is an optional dependency (see package.json) so installs that
    // never touch Excel reports stay free of its unpatched advisories.
    XLSX = require('xlsx');
  } catch {
    throw new Error(
      "Parsing .xls/.xlsx reports needs the optional 'xlsx' package. Install it with " +
        '`npm install xlsx` (or `npm install --include=optional`) and try again.',
    );
  }
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

    return makeCase({
      title: firstDefined(row, ['Test Name', 'Name', 'Test', 'Title']) || '',
      status,
      duration,
      errorMessage: clampField(stripAnsi(firstDefined(row, ['Error', 'Message', 'Failure']) || '')),
      file: firstDefined(row, ['File', 'Suite', 'Class']) || null,
      suite: firstDefined(row, ['Suite', 'Module', 'Group']) || null,
    });
  });

  return { summary, testCases };
}

module.exports = { parseExcel };
