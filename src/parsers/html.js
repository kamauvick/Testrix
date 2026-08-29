'use strict';

const fs = require('node:fs');
const cheerio = require('cheerio');

const { emptySummary, normaliseStatus, countStatus } = require('./shared');

/**
 * Parse an HTML test report, looking for the common `.test-case` / `tr.test`
 * row patterns produced by Mocha/Jest-style HTML reporters.
 * @param {string} filePath
 * @returns {Promise<{ summary: ReturnType<typeof emptySummary>, testCases: object[] }>}
 */
async function parseHtml(filePath) {
  const $ = cheerio.load(fs.readFileSync(filePath, 'utf8'));
  const summary = emptySummary();
  const testCases = [];

  $('.test-case, .test, tr.test').each((_, el) => {
    const $el = $(el);
    const status = normaliseStatus($el.find('.status, .result').first().text());
    const duration = parseFloat($el.find('.duration, .time').first().text()) || 0;
    const error = $el.find('.error, .failure, .message').first().text().trim();

    testCases.push({
      title: $el.find('.name, .test-name').first().text().trim(),
      status,
      duration,
      errorMessage: error || '',
      errorStack: '',
      file: null,
      suite: null,
    });

    summary.total += 1;
    countStatus(summary, status);
    summary.duration += duration;
  });

  return { summary, testCases };
}

module.exports = { parseHtml };
