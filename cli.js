#!/usr/bin/env node
'use strict';

const { version } = require('./package.json');
const log = require('./src/logger');
const { loadConfig } = require('./src/config');
const { publishTestReports } = require('./src/publisher');

const HELP = `testrix v${version}

Parse JUnit, Playwright, HTML and Excel test reports and publish them to a Testrix dashboard API.

Usage:
  testrix [options] [path/to/config.json]

A config file is optional. With TESTRIX_PROJECT_ID and TESTRIX_API_KEY set (or
--project / --api-key), Testrix auto-discovers reports and reads branch, commit,
environment and user from CI / git.

Options:
  -c, --config <path>    Config file path (default: ./config.json if present)
      --project <id>     Project id             (env: TESTRIX_PROJECT_ID)
      --api-key <key>    API key                (env: TESTRIX_API_KEY)
      --reports <path>   Report dir, file or glob (repeatable; env: TESTRIX_REPORTS_DIR)
      --user <id>        User id                (env: TESTRIX_USER_ID)
      --env <name>       Environment            (env: TESTRIX_ENVIRONMENT)
      --branch <name>    Branch                 (env: TESTRIX_BRANCH)
      --commit <sha>     Commit                 (env: TESTRIX_COMMIT)
      --name <name>      Test run name          (env: TESTRIX_RUN_NAME)
      --url <url>        Server API URL         (env: TESTRIX_SERVER_API_URL)
      --dashboard-url <url>  Web UI base for the "View:" link (env: TESTRIX_DASHBOARD_URL)
      --allow-insecure-url   Permit a non-https serverApiUrl (env: TESTRIX_ALLOW_INSECURE_URL)
      --timeout <ms>     Upload timeout per attempt   (env: TESTRIX_UPLOAD_TIMEOUT_MS, default 30000)
      --retries <n>      Upload attempts on transient failure (env: TESTRIX_UPLOAD_RETRIES, default 4)
      --max-cases <n>    Cap on test cases read (env: TESTRIX_MAX_CASES, default 200000; 0 = all)
      --output <fmt>     'text' (default) or 'json' (machine-readable result on stdout)
      --dry-run          Parse and summarise, but do not publish
      --fail-on-empty    Exit non-zero (2) if no tests were parsed
      --fail-on-failed   Exit non-zero (3) if any test failed
  -h, --help             Show this help
  -v, --version          Show the version

  TESTRIX_LOG_LEVEL      silent | error | warn | info (default) | debug

Exit codes: 0 ok · 1 error (config / parse / upload) · 2 --fail-on-empty · 3 --fail-on-failed
`;

// flag -> config key (all take a value)
const VALUE_FLAGS = {
  '--project': 'projectId',
  '--api-key': 'apiKey',
  '--reports': 'reports',
  '--user': 'userId',
  '--env': 'environment',
  '--branch': 'branch',
  '--commit': 'commit',
  '--name': 'name',
  '--url': 'serverApiUrl',
  '--dashboard-url': 'dashboardUrl',
  '--timeout': 'timeout',
  '--retries': 'retries',
  '--max-cases': 'maxCases',
  '--output': 'output',
  '-c': 'config',
  '--config': 'config',
};
const BOOL_FLAGS = new Set([
  '--dry-run',
  '--fail-on-empty',
  '--fail-on-failed',
  '--allow-insecure-url',
]);

function parseArgs(args) {
  const parsed = { overrides: {}, reports: [], flags: {} };
  const take = (flag, inlineValue, next) => {
    const value = inlineValue !== undefined ? inlineValue : next();
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    const key = VALUE_FLAGS[flag];
    if (key === 'config') parsed.configPath = value;
    else if (key === 'reports') parsed.reports.push(value);
    else if (key === 'timeout' || key === 'retries' || key === 'output') parsed.flags[key] = value;
    else if (key === 'maxCases') parsed.overrides.maxCases = num(value, '--max-cases');
    else parsed.overrides[key] = value;
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') return { help: true };
    if (arg === '-v' || arg === '--version') return { showVersion: true };

    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const bare = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    if (BOOL_FLAGS.has(bare)) {
      parsed.flags[bare.replace(/^--/, '')] = true;
    } else if (VALUE_FLAGS[bare]) {
      take(bare, inline, () => args[(i += 1)]);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!parsed.configPath) {
      parsed.configPath = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return parsed;
}

/** Turn `--reports` values (dir / file / glob) into reportsDir + reportFiles overrides. */
function reportsToOverrides(values, overrides) {
  if (values.length === 0) return;
  const files = [];
  for (const value of values) {
    if (/[*?[\]{}]/.test(value) || /\.(xml|json|html?|xls[xm]?)$/i.test(value)) files.push(value);
    else overrides.reportsDir = value;
  }
  if (files.length > 0) overrides.reportFiles = files;
}

const num = (value, label) => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative number`);
  return n;
};

async function main(argv) {
  const parsed = parseArgs(argv.slice(2));
  if (parsed.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsed.showVersion) {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  const outputJson = parsed.flags.output === 'json';
  if (parsed.flags.output && !['text', 'json'].includes(parsed.flags.output)) {
    throw new Error("--output must be 'text' or 'json'");
  }
  if (outputJson) log.routeToStderr(); // keep stdout clean for the JSON result

  reportsToOverrides(parsed.reports, parsed.overrides);
  if (parsed.flags['allow-insecure-url']) parsed.overrides.allowInsecureUrl = true;
  const configPath = parsed.configPath || 'config.json';
  log.debug(`Loading config (file: ${configPath} if present)`);
  const config = loadConfig(configPath, parsed.overrides);
  log.addSecret(config.apiKey); // never let the key reach a log line

  const result = await publishTestReports(config, {
    dryRun: Boolean(parsed.flags['dry-run']),
    timeoutMs: num(parsed.flags.timeout, '--timeout'),
    retries: num(parsed.flags.retries, '--retries'),
  });

  if (outputJson) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        dryRun: result.dryRun,
        testRunId: result.testRunId ?? null,
        url: result.url ?? null,
        published: result.published,
        summary: result.summary,
      })}\n`,
    );
  }

  // A successful publish exits 0 even when some tests failed, unless the caller
  // opted into a stricter gate.
  if (parsed.flags['fail-on-empty'] && result.summary.total === 0) {
    log.error('No tests were parsed (--fail-on-empty).');
    return 2;
  }
  if (parsed.flags['fail-on-failed'] && result.summary.failed > 0) {
    log.error(`${result.summary.failed} test(s) failed (--fail-on-failed).`);
    return 3;
  }
  return 0;
}

main(process.argv)
  .then((code) => process.exit(code))
  .catch((err) => {
    log.error(err.message);
    if (process.env.TESTRIX_LOG_LEVEL === 'debug' && err.stack) log.debug(err.stack);
    process.exit(1);
  });
