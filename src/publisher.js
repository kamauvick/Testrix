'use strict';

const fs = require('node:fs');
const path = require('node:path');

const log = require('./logger');
const { parserForFile, parseJUnit, emptySummary } = require('./parsers');

const REPORT_EXTENSIONS = new Set(['.xml', '.html', '.htm', '.xls', '.xlsx']);

/** List report files directly inside a directory (non-recursive). */
function enumerateDirectory(directoryPath) {
  return fs
    .readdirSync(directoryPath)
    .filter((name) => {
      const ext = path.extname(name).toLowerCase();
      if (REPORT_EXTENSIONS.has(ext)) return true;
      return ext === '' && /junit/i.test(name); // e.g. vitest's `frontend-junit`
    })
    .map((name) => path.join(directoryPath, name));
}

/** Expand an explicit list of file/dir paths into a flat list of files. */
function collectExplicit(inputs) {
  const files = [];
  for (const input of inputs) {
    const resolved = path.resolve(input);
    if (!fs.existsSync(resolved)) {
      log.warn(`Explicit report path does not exist, skipping: ${resolved}`);
      continue;
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) files.push(...enumerateDirectory(resolved));
    else if (stat.isFile()) files.push(resolved);
  }
  return files;
}

/**
 * Resolve the set of report files to parse from `reportsDir` plus any explicit
 * `reportFiles`.
 * @param {import('./config').TestrixConfig} config
 * @returns {string[]}
 */
function discoverReportFiles(config) {
  const reportsDir = path.resolve(config.reportsDir);
  const files = new Set(enumerateDirectory(reportsDir));
  if (Array.isArray(config.reportFiles) && config.reportFiles.length > 0) {
    log.debug('Including explicit report files:', config.reportFiles.join(', '));
    for (const file of collectExplicit(config.reportFiles)) files.add(file);
  }
  if (files.size === 0) {
    throw new Error(`No report files (.xml, .html, .xls/.xlsx or *junit*) found in ${reportsDir}`);
  }
  return [...files];
}

/**
 * Parse every report file and merge the results.
 * @param {string[]} files
 * @returns {Promise<{ summary: object, testCases: object[], suites: string[] }>}
 */
async function parseReports(files) {
  const summary = emptySummary();
  const testCases = [];
  const suites = new Set();

  for (const file of files) {
    const parser = parserForFile(file);
    if (!parser) {
      log.warn(`Unsupported report type, skipping: ${file}`);
      continue;
    }
    log.info(`Parsing ${path.basename(file)}`);
    let result;
    try {
      result = await parser(file);
    } catch (err) {
      if (parser === parseJUnit && path.extname(file) === '') {
        log.warn(
          `Could not parse extensionless file as JUnit XML, skipping: ${file} (${err.message})`,
        );
        continue;
      }
      throw new Error(`Failed to parse ${file}: ${err.message}`);
    }

    for (const key of ['total', 'passed', 'failed', 'skipped', 'duration']) {
      summary[key] += result.summary[key];
    }
    testCases.push(...result.testCases);
    for (const tc of result.testCases) if (tc.suite) suites.add(tc.suite);
  }

  return { summary, testCases, suites: [...suites] };
}

/** Build the request body the dashboard API expects. */
function buildPayload(config, { testCases, suites }) {
  const now = new Date().toISOString();
  const payload = {
    testRun: {
      name: suites.length > 0 ? suites.join(', ') : config.name || 'Test Run',
      userId: config.userId,
      projectId: config.projectId,
      environment: config.environment || null,
      branch: config.branch || null,
      commit: config.commit || null,
      startTime: config.startTime || now,
      endTime: config.endTime || now,
    },
    testCases: testCases.map((tc) => ({
      title: tc.title || '',
      status: tc.status,
      duration: Math.round(Number(tc.duration) || 0),
      errorMessage: tc.errorMessage ? String(tc.errorMessage) : '',
      errorStack: tc.errorStack ? String(tc.errorStack) : '',
      file: tc.file || '',
      suite: tc.suite || '',
    })),
  };
  if (config.includeSuitesInPayload && suites.length > 0) {
    payload.testRun.suites = suites;
  }
  return payload;
}

/** POST the payload to the dashboard API. Throws on a non-2xx response. */
async function submit(config, payload) {
  log.info(`Publishing ${payload.testCases.length} test case(s) to ${config.serverApiUrl}`);
  const response = await fetch(config.serverApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Server responded ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`,
    );
  }
}

/**
 * Discover, parse and publish test reports described by `config`.
 * @param {import('./config').TestrixConfig} config
 * @returns {Promise<{ summary: object, published: number }>}
 */
async function publishTestReports(config) {
  const files = discoverReportFiles(config);
  log.info(`Found ${files.length} report file(s)`);

  const { summary, testCases, suites } = await parseReports(files);
  log.info(
    `Parsed ${summary.total} test(s): ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`,
  );

  const payload = buildPayload(config, { testCases, suites });
  await submit(config, payload);
  log.info('Test results published successfully.');

  return { summary, published: payload.testCases.length };
}

module.exports = {
  publishTestReports,
  discoverReportFiles,
  parseReports,
  buildPayload,
};
