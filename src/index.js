'use strict';

/**
 * Public API for programmatic use:
 *
 *   const { loadConfig, publishTestReports } = require('testrix-cli');
 */
const { loadConfig, resolveConfig, DEFAULT_API_URL } = require('./config');
// Re-exports parseJUnit / parseHtml / parseExcel / parsePlaywrightJson and helpers.
const parsers = require('./parsers');
const {
  publishTestReports,
  discoverReportFiles,
  parseReports,
  buildPayload,
} = require('./publisher');
const { createReporter } = require('./reporter');

module.exports = {
  loadConfig,
  resolveConfig,
  DEFAULT_API_URL,
  publishTestReports,
  createReporter,
  discoverReportFiles,
  parseReports,
  buildPayload,
  ...parsers,
};
