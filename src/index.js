'use strict';

/**
 * Public API for programmatic use:
 *
 *   const { loadConfig, publishTestReports } = require('testrix-cli');
 */
const { loadConfig, resolveConfig, DEFAULT_API_URL } = require('./config');
const parsers = require('./parsers');
const {
  publishTestReports,
  discoverReportFiles,
  parseReports,
  buildPayload,
} = require('./publisher');

module.exports = {
  loadConfig,
  resolveConfig,
  DEFAULT_API_URL,
  publishTestReports,
  discoverReportFiles,
  parseReports,
  buildPayload,
  ...parsers,
};
