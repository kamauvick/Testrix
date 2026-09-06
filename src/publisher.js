'use strict';

const fs = require('node:fs');
const path = require('node:path');

const log = require('./logger');
const {
  streamParserForFile,
  streamJUnit,
  streamTestNG,
  streamNUnit,
  countStatus,
  emptySummary,
} = require('./parsers');
const { isGlob, expandAll } = require('./glob');
const { submitReport, deriveRunUrl } = require('./http');
const { redactUrl } = require('./redact');

const REPORT_EXTENSIONS = new Set([
  '.xml',
  '.json',
  '.jtl',
  '.tap',
  '.trx',
  '.html',
  '.htm',
  '.xls',
  '.xlsx',
]);

// `.json` files that live next to reports but are never test reports themselves.
const NON_REPORT_JSON = new Set([
  'package.json',
  'package-lock.json',
  'composer.json',
  'composer.lock',
  'tsconfig.json',
  'jsconfig.json',
  '.eslintrc.json',
  '.prettierrc.json',
  'nx.json',
  'angular.json',
]);

const isNonReportJson = (name) =>
  NON_REPORT_JSON.has(name.toLowerCase()) || /^tsconfig\..*\.json$/i.test(name);

// Directories (relative to cwd) probed for reports when `reportsDir` is not set.
// Ordered most- to least-specific; `.` is the last resort.
const REPORT_DIR_CANDIDATES = ['test-results', 'test-reports', 'reports', 'junit', '.'];

/** List report files directly inside a directory (non-recursive). */
function enumerateDirectory(directoryPath) {
  let names;
  try {
    names = fs.readdirSync(directoryPath);
  } catch {
    return []; // missing / unreadable directory
  }
  return names
    .filter((name) => {
      const ext = path.extname(name).toLowerCase();
      if (ext === '.json') return !isNonReportJson(name);
      if (REPORT_EXTENSIONS.has(ext)) return true;
      return ext === '' && /junit/i.test(name); // e.g. vitest's `frontend-junit`
    })
    .map((name) => path.join(directoryPath, name));
}

/** Probe {@link REPORT_DIR_CANDIDATES} for the first directory that holds reports. */
function autoDiscoverReportsDir() {
  for (const candidate of REPORT_DIR_CANDIDATES) {
    const dir = path.resolve(candidate);
    if (enumerateDirectory(dir).length > 0) {
      log.debug(`Auto-discovered reports in ${dir}`);
      return dir;
    }
  }
  return null;
}

/**
 * Expand an explicit list of file / directory / glob patterns into a flat list
 * of files. Glob patterns (`reports/**\/*.xml`, `junit-*.json`, `{a,b}.xml`) are
 * matched recursively from their static base.
 */
function collectExplicit(inputs) {
  const globs = inputs.filter(isGlob);
  const plain = inputs.filter((p) => !isGlob(p));

  const files = [...expandAll(globs)];
  for (const input of plain) {
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
  const explicit = Array.isArray(config.reportFiles) ? config.reportFiles : [];

  let reportsDir = null;
  if (config.reportsDir) {
    reportsDir = path.resolve(config.reportsDir);
    if (!fs.existsSync(reportsDir)) {
      throw new Error(`reportsDir does not exist: ${reportsDir}`);
    }
  } else if (explicit.length === 0) {
    reportsDir = autoDiscoverReportsDir();
    if (!reportsDir) {
      throw new Error(
        `No test reports found (looked in ${REPORT_DIR_CANDIDATES.join(', ')}). Point Testrix ` +
          'at them with reportsDir, TESTRIX_REPORTS_DIR, or --reports <dir|file>.',
      );
    }
  }

  const files = new Set(reportsDir ? enumerateDirectory(reportsDir) : []);
  if (explicit.length > 0) {
    log.debug('Including explicit report files:', explicit.join(', '));
    for (const file of collectExplicit(explicit)) files.add(file);
  }
  if (files.size === 0) {
    throw new Error(
      'No report files (.xml, .json, .jtl, .tap, .trx, .html, .xls/.xlsx or *junit*) found in ' +
        (reportsDir || explicit.join(', ')),
    );
  }
  return [...files];
}

// Extensionless files are sniffed as one of these three XML dialects (see
// sniffXmlFormat); a parse failure on any of them is "wrong format", not a
// reason to abort the whole run - not just the JUnit fallback case.
const EXTENSIONLESS_XML_STREAMERS = new Set([streamJUnit, streamTestNG, streamNUnit]);

/** Is this a "valid file, wrong format" error we can skip past rather than abort on? */
function isSkippable(streamer, file, err) {
  if (err.skippable) return true; // e.g. a .json that isn't a Playwright report
  return EXTENSIONLESS_XML_STREAMERS.has(streamer) && path.extname(file) === '';
}

/**
 * Stream and merge every report file. Records are pulled one at a time from a
 * streaming parser (JUnit is truly streaming; other formats are adapted), so a
 * single huge report never has to sit in memory as a DOM. `maxCases` bounds the
 * total number of records pulled - `0` means unlimited.
 * @param {string[]} files
 * @param {{ maxCases?: number }} [options]
 * @returns {Promise<{ summary: object, testCases: object[], suites: string[], startTime: ?string, endTime: ?string, truncated: boolean }>}
 */
async function parseReports(files, { maxCases = 0 } = {}) {
  const summary = emptySummary();
  const testCases = [];
  const suites = new Set();
  let startTime = null;
  let endTime = null;
  let truncated = false;

  for (const file of files) {
    if (maxCases && testCases.length >= maxCases) {
      truncated = true;
      break;
    }
    // streamParserForFile() does its own file I/O for .xml/.json (content
    // sniffing), so it can fail the same way an actual parse can (file
    // removed after discovery, a permission error, ...) - treat that as a
    // per-file skip too, not an abort of the whole run.
    let streamer;
    try {
      streamer = streamParserForFile(file);
    } catch (err) {
      log.warn(`Skipping ${path.basename(file)}: could not inspect file (${err.message})`);
      continue;
    }
    if (!streamer) {
      if (path.extname(file).toLowerCase() === '.zip') {
        log.warn(
          `Skipping ${path.basename(file)}: Playwright blob reports must be merged first - run ` +
            '`npx playwright merge-reports --reporter junit ./blob-report` and publish the result.',
        );
      } else {
        log.warn(`Unsupported report type, skipping: ${file}`);
      }
      continue;
    }
    log.info(`Parsing ${path.basename(file)}`);
    const acc = {};
    try {
      for await (const rec of streamer(file, acc)) {
        if (maxCases && testCases.length >= maxCases) {
          truncated = true;
          break;
        }
        testCases.push(rec);
        summary.total += 1;
        countStatus(summary, rec.status);
        summary.duration += rec.duration || 0;
        if (rec.suite) suites.add(rec.suite);
      }
    } catch (err) {
      if (isSkippable(streamer, file, err)) {
        log.warn(`Skipping ${path.basename(file)}: ${err.message}`);
        continue;
      }
      throw new Error(`Failed to parse ${file}: ${err.message}`);
    }

    // Widen the run window to span every report (ISO-8601 UTC sorts chronologically).
    if (acc.startTime && (!startTime || acc.startTime < startTime)) startTime = acc.startTime;
    if (acc.endTime && (!endTime || acc.endTime > endTime)) endTime = acc.endTime;
  }

  if (truncated) {
    log.warn(
      `Reached the ${maxCases.toLocaleString()}-case limit; further test cases were not read. ` +
        'Raise it with --max-cases (0 = unlimited).',
    );
  }

  return { summary, testCases, suites: [...suites], startTime, endTime, truncated };
}

/**
 * Classify Playwright attachments into the screenshot / video / trace slots the
 * dashboard's TestCase model exposes. First match of each kind wins.
 */
function pickArtifacts(attachments) {
  const out = {};
  for (const att of attachments || []) {
    const p = att && att.path;
    if (!p) continue;
    const type = String(att.contentType || '').toLowerCase();
    const name = String(att.name || '').toLowerCase();
    if (!out.screenshot && (type.startsWith('image/') || /\.(png|jpe?g|gif)$/.test(name)))
      out.screenshot = p;
    else if (!out.video && (type.startsWith('video/') || /\.(webm|mp4)$/.test(name))) out.video = p;
    else if (
      !out.trace &&
      (type === 'application/zip' || name.includes('trace') || /\.zip$/.test(name))
    )
      out.trace = p;
  }
  return out;
}

/** Build the request body the dashboard API expects. */
function buildPayload(config, { testCases, suites, startTime, endTime }) {
  const now = new Date().toISOString();
  const projects = new Set(testCases.map((tc) => tc.project).filter(Boolean));
  const multiProject = projects.size > 1;

  const payload = {
    testRun: {
      name: suites.length > 0 ? suites.join(', ') : config.name || 'Test Run',
      userId: config.userId,
      projectId: config.projectId,
      environment: config.environment || null,
      branch: config.branch || null,
      commit: config.commit || null,
      startTime: config.startTime || startTime || now,
      endTime: config.endTime || endTime || now,
    },
    testCases: testCases.map((tc) => {
      const suite = tc.suite || '';
      const out = {
        title: tc.title || '',
        status: tc.status,
        duration: Math.round(Number(tc.duration) || 0),
        errorMessage: tc.errorMessage ? String(tc.errorMessage) : '',
        errorStack: tc.errorStack ? String(tc.errorStack) : '',
        file: tc.file || '',
        suite: multiProject && tc.project ? `[${tc.project}] ${suite}`.trim() : suite,
      };
      if (Number.isFinite(tc.line)) out.line = tc.line; // preserves a legitimate line 0
      if (tc.retries) out.retryCount = tc.retries;
      const art = pickArtifacts(tc.attachments);
      if (art.screenshot) out.screenshot = art.screenshot;
      if (art.video) out.video = art.video;
      if (art.trace) out.trace = art.trace;
      return out;
    }),
  };
  if (config.includeSuitesInPayload && suites.length > 0) {
    payload.testRun.suites = suites;
  }
  return payload;
}

/**
 * Discover, parse and publish test reports described by `config`.
 *
 * `options.onEvent(name, data)` - if given - is called at each stage
 * (`discover`, `parse`, `upload:start`, `upload:done`) for callers that want
 * progress rather than just the final promise; see {@link createReporter}.
 * @param {import('./config').TestrixConfig} config
 * @param {{ dryRun?: boolean, retries?: number, timeoutMs?: number, gzip?: boolean, maxUploadBytes?: number, onEvent?: (name: string, data: object) => void }} [options]
 * @returns {Promise<{ summary: object, published: number, testRunId?: string, url?: string, dryRun: boolean, timings: { discoverMs: number, parseMs: number, uploadMs: number } }>}
 */
async function publishTestReports(config, options = {}) {
  const { dryRun = false, onEvent = () => {} } = options;
  const t0 = Date.now();

  const files = discoverReportFiles(config);
  const t1 = Date.now();
  log.info(`Found ${files.length} report file(s)`);
  onEvent('discover', { files });

  const { summary, testCases, suites, startTime, endTime, truncated } = await parseReports(files, {
    maxCases: config.maxCases,
  });
  const t2 = Date.now();
  const flakyNote = summary.flaky > 0 ? `, ${summary.flaky} flaky` : '';
  log.info(
    `Parsed ${summary.total} test(s): ${summary.passed} passed, ${summary.failed} failed, ` +
      `${summary.skipped} skipped${flakyNote}`,
  );
  onEvent('parse', { summary, truncated });

  const payload = buildPayload(config, { testCases, suites, startTime, endTime });
  if (dryRun) {
    log.info(`Dry run - not publishing. Payload has ${payload.testCases.length} test case(s).`);
    log.debug(JSON.stringify(payload, null, 2));
    onEvent('done', { summary, dryRun: true });
    return {
      summary,
      published: 0,
      dryRun: true,
      timings: { discoverMs: t1 - t0, parseMs: t2 - t1, uploadMs: 0 },
    };
  }

  log.info(
    `Publishing ${payload.testCases.length} test case(s) to ${redactUrl(config.serverApiUrl)}`,
  );
  onEvent('upload:start', { count: payload.testCases.length });
  const { testRunId } = await submitReport(config, payload, options);
  const t3 = Date.now();
  const url = deriveRunUrl(config.serverApiUrl, testRunId, config.dashboardUrl);
  log.info(`Test results published successfully.${url ? ` View: ${url}` : ''}`);
  log.debug(`Timing: discover ${t1 - t0}ms, parse ${t2 - t1}ms, upload ${t3 - t2}ms`);
  onEvent('upload:done', { testRunId, url });

  return {
    summary,
    published: payload.testCases.length,
    testRunId,
    url,
    dryRun: false,
    timings: { discoverMs: t1 - t0, parseMs: t2 - t1, uploadMs: t3 - t2 },
  };
}

module.exports = {
  publishTestReports,
  discoverReportFiles,
  parseReports,
  buildPayload,
  REPORT_EXTENSIONS,
};
