'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_API_URL = 'https://testing-dashboard-api.myworkpay.com/api/submit-test-reports';
const REQUIRED_KEYS = ['userId', 'projectId', 'apiKey', 'reportsDir'];

/**
 * @typedef {Object} TestrixConfig
 * @property {string} serverApiUrl
 * @property {string} userId
 * @property {string} projectId
 * @property {string} apiKey
 * @property {string} reportsDir
 * @property {string[]} [reportFiles]
 * @property {boolean} [includeSuitesInPayload]
 * @property {string} [name]
 * @property {string} [environment]
 * @property {string} [branch]
 * @property {string} [commit]
 * @property {string} [startTime]
 * @property {string} [endTime]
 * @property {string} [projectDescription]
 */

function readConfigFile(configPath) {
  const resolved = path.resolve(configPath);
  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read config file at ${resolved}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Config file at ${resolved} is not valid JSON: ${err.message}`);
  }
}

/**
 * Merge a raw config object with environment overrides and defaults, then
 * validate it. Throws an Error with an actionable message on invalid input.
 * @param {Record<string, unknown>} fileConfig
 * @returns {TestrixConfig}
 */
function resolveConfig(fileConfig) {
  const config = {
    ...fileConfig,
    serverApiUrl: fileConfig.serverApiUrl || process.env.TESTRIX_SERVER_API_URL || DEFAULT_API_URL,
    projectId: fileConfig.projectId || process.env.TESTRIX_PROJECT_ID,
    apiKey: fileConfig.apiKey || process.env.TESTRIX_API_KEY,
  };

  const missing = REQUIRED_KEYS.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required config: ${missing.join(', ')}. Set them in your config file, ` +
        'or provide projectId / apiKey via TESTRIX_PROJECT_ID and TESTRIX_API_KEY.',
    );
  }

  if (config.reportFiles !== undefined && !Array.isArray(config.reportFiles)) {
    throw new Error('config.reportFiles must be an array of file or directory paths.');
  }

  try {
    void new URL(config.serverApiUrl);
  } catch {
    throw new Error(`config.serverApiUrl is not a valid URL: ${config.serverApiUrl}`);
  }

  return config;
}

/**
 * Load and validate a Testrix config file.
 * @param {string} configPath
 * @returns {TestrixConfig}
 */
function loadConfig(configPath) {
  return resolveConfig(readConfigFile(configPath));
}

module.exports = { loadConfig, resolveConfig, DEFAULT_API_URL };
