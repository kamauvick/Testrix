'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detectCiMetadata, detectGitMetadata } = require('./ci');
const { DEFAULT_MAX_CASES, toInt } = require('./limits');
const { findConfigFile } = require('./config-discovery');
const log = require('./logger');

const DEFAULT_API_URL = 'https://testing-dashboard-api.myworkpay.com/api/submit-test-reports';

// The only values Testrix cannot work without. Everything else is defaulted,
// read from the environment, taken from CI, or discovered on disk.
const REQUIRED_KEYS = ['projectId', 'apiKey'];

/**
 * @typedef {Object} TestrixConfig
 * @property {string} serverApiUrl
 * @property {string} [dashboardUrl]   Web UI base, for the "View:" link after publish.
 * @property {string} userId
 * @property {string} projectId
 * @property {string} apiKey
 * @property {string} [reportsDir]   Optional - auto-discovered when omitted.
 * @property {string[]} [reportFiles]
 * @property {boolean} [includeSuitesInPayload]
 * @property {string} [name]
 * @property {string} [environment]
 * @property {string} [branch]
 * @property {string} [commit]
 * @property {string} [startTime]
 * @property {string} [endTime]
 * @property {number} [maxCases]   Cap on test cases pulled from the reports; 0 = unlimited.
 * @property {boolean} [allowInsecureUrl]
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

/** First argument that is neither undefined, null, nor an empty string. */
const firstSet = (...values) =>
  values.find((v) => v !== undefined && v !== null && v !== '') ?? undefined;

function osUsername() {
  try {
    return os.userInfo().username || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merge a raw config object with, in order of precedence:
 *   1. the config object itself (from a file and/or CLI flags)
 *   2. `TESTRIX_*` environment variables
 *   3. CI provider environment variables (GitHub, GitLab, CircleCI, Jenkins, ...)
 *   4. local `git` metadata
 *   5. built-in defaults
 * then validate. Throws an Error with an actionable message on invalid input.
 * @param {Record<string, unknown>} [fileConfig]
 * @returns {TestrixConfig}
 */
function resolveConfig(fileConfig = {}) {
  const env = process.env;
  const ci = detectCiMetadata(env);
  let gitMeta;
  const git = () => (gitMeta ??= detectGitMetadata());

  const config = {
    ...fileConfig,
    serverApiUrl: firstSet(fileConfig.serverApiUrl, env.TESTRIX_SERVER_API_URL, DEFAULT_API_URL),
    dashboardUrl: firstSet(fileConfig.dashboardUrl, env.TESTRIX_DASHBOARD_URL),
    allowInsecureUrl: Boolean(fileConfig.allowInsecureUrl || env.TESTRIX_ALLOW_INSECURE_URL),
    projectId: firstSet(fileConfig.projectId, env.TESTRIX_PROJECT_ID),
    apiKey: firstSet(fileConfig.apiKey, env.TESTRIX_API_KEY),
    userId:
      firstSet(fileConfig.userId, env.TESTRIX_USER_ID, ci.userId, git().userId, osUsername()) ||
      'testrix-cli',
    reportsDir: firstSet(fileConfig.reportsDir, env.TESTRIX_REPORTS_DIR),
    name: firstSet(fileConfig.name, env.TESTRIX_RUN_NAME, ci.name),
    environment: firstSet(fileConfig.environment, env.TESTRIX_ENVIRONMENT, ci.environment) ?? null,
    branch: firstSet(fileConfig.branch, env.TESTRIX_BRANCH, ci.branch, git().branch) ?? null,
    commit: firstSet(fileConfig.commit, env.TESTRIX_COMMIT, ci.commit, git().commit) ?? null,
    maxCases: toInt(firstSet(fileConfig.maxCases, env.TESTRIX_MAX_CASES), DEFAULT_MAX_CASES),
  };

  const missing = REQUIRED_KEYS.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required config: ${missing.join(', ')}. Provide them in a config file, as ` +
        'CLI flags (--project, --api-key), or via TESTRIX_PROJECT_ID / TESTRIX_API_KEY.',
    );
  }

  if (config.reportFiles !== undefined && !Array.isArray(config.reportFiles)) {
    throw new Error('config.reportFiles must be an array of file or directory paths.');
  }

  let apiUrl;
  try {
    apiUrl = new URL(config.serverApiUrl);
  } catch {
    throw new Error(`config.serverApiUrl is not a valid URL: ${config.serverApiUrl}`);
  }

  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (
    apiUrl.protocol !== 'https:' &&
    !localHosts.has(apiUrl.hostname) &&
    !config.allowInsecureUrl
  ) {
    throw new Error(
      `serverApiUrl must use https (got ${apiUrl.protocol}//${apiUrl.host}). ` +
        'Pass --allow-insecure-url or set TESTRIX_ALLOW_INSECURE_URL to override for a trusted host.',
    );
  }

  return config;
}

const withoutUndefined = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

/**
 * Load and validate configuration. Both arguments are optional.
 *
 * With an explicit `configPath`, it must exist (except the literal default
 * `"config.json"`, which is fine to be absent). With none, Testrix looks for
 * `testrix.config.{json,cjs,js}` / `.testrixrc(.json)` / a `testrix` key in
 * `package.json`, walking up from cwd (see `config-discovery.js`), then falls
 * back to a `config.json` in cwd, then to CLI overrides / env / CI / git alone.
 * @param {string} [configPath]
 * @param {Partial<TestrixConfig>} [overrides]  Highest-precedence values (CLI flags).
 * @returns {TestrixConfig}
 */
function loadConfig(configPath, overrides = {}) {
  let fileConfig = {};
  if (configPath) {
    if (fs.existsSync(path.resolve(configPath))) {
      fileConfig = readConfigFile(configPath);
      log.debug(`Config loaded from ${path.resolve(configPath)}`);
    } else if (path.basename(configPath) !== 'config.json') {
      // An explicit non-default path that doesn't exist is a mistake worth
      // reporting; the default "config.json" simply being absent is fine.
      throw new Error(`Config file not found: ${path.resolve(configPath)}`);
    }
  } else {
    const found = findConfigFile();
    if (found) {
      fileConfig = found.config;
      log.debug(`Config loaded from ${found.path}`);
    } else if (fs.existsSync(path.resolve('config.json'))) {
      fileConfig = readConfigFile('config.json');
      log.debug(`Config loaded from ${path.resolve('config.json')}`);
    }
  }
  return resolveConfig({ ...fileConfig, ...withoutUndefined(overrides) });
}

module.exports = { loadConfig, resolveConfig, DEFAULT_API_URL, findConfigFile };
