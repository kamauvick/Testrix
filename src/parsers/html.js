'use strict';

const fs = require('node:fs');

// `cheerio` is only needed for HTML reports - load it lazily (see excel.js).
const { emptySummary, normaliseStatus, stripAnsi, accumulate, makeCase } = require('./shared');
const { clampField } = require('../limits');

/**
 * Parse an HTML test report, looking for the common `.test-case` / `tr.test`
 * row patterns produced by Mocha/Jest-style HTML reporters.
 * @param {string} filePath
 * @returns {Promise<{ summary: ReturnType<typeof emptySummary>, testCases: object[], startTime: null, endTime: null }>}
 */
async function parseHtml(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');

  // Playwright's HTML report is a single-page app - the results live in a
  // base64-encoded zip, not in scrapable rows. Fail loudly with the fix rather
  // than silently publishing zero tests.
  if (/playwrightReportBase64|<div id="root">\s*<\/div>\s*<script/.test(raw)) {
    const err = new Error(
      'This looks like a Playwright HTML report, which has no machine-readable rows. ' +
        "Add the 'junit' or 'json' reporter alongside 'html' and point Testrix at that file.",
    );
    err.skippable = true;
    throw err;
  }

  const $ = require('cheerio').load(raw);
  const summary = emptySummary();
  const testCases = [];

  $('.test-case, .test, tr.test').each((_, el) => {
    const $el = $(el);
    const status = normaliseStatus($el.find('.status, .result').first().text());
    const duration = parseFloat($el.find('.duration, .time').first().text()) || 0;
    const error = $el.find('.error, .failure, .message').first().text().trim();

    const rec = makeCase({
      title: $el.find('.name, .test-name').first().text().trim(),
      status,
      duration,
      errorMessage: clampField(stripAnsi(error)),
    });
    testCases.push(rec);
    accumulate(summary, rec);
  });

  return { summary, testCases, startTime: null, endTime: null };
}

module.exports = { parseHtml };
