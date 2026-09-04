#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { version } = require('./package.json');
const log = require('./src/logger');
const { loadConfig } = require('./src/config');
const { publishTestReports } = require('./src/publisher');
const { detectCiMetadata } = require('./src/ci');

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
      --max-upload-bytes <n>  Reject the upload locally above this size (env: TESTRIX_MAX_UPLOAD_BYTES, default 20MB)
      --gzip             Compress the upload body (env: TESTRIX_GZIP; only if your server inflates it)
      --output <fmt>     'text' (default) or 'json' (machine-readable result on stdout)
      --log-format <fmt> 'text' (default) or 'json' (one JSON object per log line, to stderr/stdout per --output)
      --debug-bundle <path>  Write resolved config, files, summary & timings (secrets redacted) as JSON, for bug reports
      --print-config     Print the fully-resolved config (secrets redacted) and exit
      --dry-run          Parse and summarise, but do not publish
      --fail-on-empty    Exit non-zero (2) if no tests were parsed
      --fail-on-failed   Exit non-zero (3) if any test failed
  -h, --help             Show this help
  -v, --version          Show the version

Commands:
  testrix init           Scaffold testrix.config.json and print a CI snippet

  TESTRIX_LOG_LEVEL      silent | error | warn | info (default) | debug

Exit codes: 0 ok · 1 error (config / parse / upload) · 2 --fail-on-empty · 3 --fail-on-failed

Config is found, in order: -c/--config <path> > testrix.config.{json,cjs,js}
> .testrixrc(.json) > a "testrix" key in package.json (searched walking up
from cwd) > ./config.json > CLI flags / env / CI / git alone.
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
  '--max-upload-bytes': 'maxUploadBytes',
  '--output': 'output',
  '--log-format': 'logFormat',
  '--debug-bundle': 'debugBundle',
  '-c': 'config',
  '--config': 'config',
};
const BOOL_FLAGS = new Set([
  '--dry-run',
  '--fail-on-empty',
  '--fail-on-failed',
  '--allow-insecure-url',
  '--gzip',
  '--print-config',
]);

function parseArgs(args) {
  const parsed = { overrides: {}, reports: [], flags: {} };
  const take = (flag, inlineValue, next) => {
    const value = inlineValue !== undefined ? inlineValue : next();
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    const key = VALUE_FLAGS[flag];
    if (key === 'config') parsed.configPath = value;
    else if (key === 'reports') parsed.reports.push(value);
    else if (
      key === 'timeout' ||
      key === 'retries' ||
      key === 'output' ||
      key === 'logFormat' ||
      key === 'debugBundle'
    ) {
      const flagKey = { logFormat: 'log-format', debugBundle: 'debug-bundle' }[key] || key;
      parsed.flags[flagKey] = value;
    } else if (key === 'maxCases') parsed.overrides.maxCases = num(value, '--max-cases');
    else if (key === 'maxUploadBytes')
      parsed.flags.maxUploadBytes = num(value, '--max-upload-bytes');
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

const CI_SNIPPETS = {
  github: [
    '# .github/workflows/test.yml',
    '- run: npx testrix-cli',
    '  env:',
    '    TESTRIX_PROJECT_ID: ${{ secrets.TESTRIX_PROJECT_ID }}',
    '    TESTRIX_API_KEY: ${{ secrets.TESTRIX_API_KEY }}',
  ],
  gitlab: [
    '# .gitlab-ci.yml',
    'testrix:',
    '  script:',
    '    - npx testrix-cli',
    '  variables:',
    '    TESTRIX_PROJECT_ID: $TESTRIX_PROJECT_ID',
    '    TESTRIX_API_KEY: $TESTRIX_API_KEY',
  ],
  circleci: [
    '# .circleci/config.yml',
    '- run:',
    '    name: Publish test results',
    '    command: npx testrix-cli',
    '    environment:',
    '      TESTRIX_PROJECT_ID: $TESTRIX_PROJECT_ID',
  ],
  jenkins: [
    '// Jenkinsfile',
    "sh 'npx testrix-cli'",
    '// set TESTRIX_PROJECT_ID / TESTRIX_API_KEY via withCredentials or the environment {} block',
  ],
  bitbucket: ['# bitbucket-pipelines.yml', '- step:', '    script:', '      - npx testrix-cli'],
  ci: [
    'npx testrix-cli',
    '# set TESTRIX_PROJECT_ID and TESTRIX_API_KEY as secrets in your CI provider',
  ],
};

/**
 * Write a JSON snapshot (secrets redacted) of what happened during a run -
 * resolved config, discovered files, parse summary, timings, and the error
 * message if the run failed - for attaching to a bug report. Despite the flag
 * name this is one JSON file, not an archive; the name matches TODO.md E10's
 * "debug bundle" and is kept simple deliberately.
 */
function writeDebugBundle(bundlePath, data) {
  try {
    fs.writeFileSync(path.resolve(bundlePath), `${JSON.stringify(data, null, 2)}\n`);
    log.info(`Wrote debug bundle to ${path.resolve(bundlePath)}`);
  } catch (err) {
    log.warn(`Could not write debug bundle to ${bundlePath}: ${err.message}`);
  }
}

function runInit() {
  const target = path.resolve('testrix.config.json');
  if (fs.existsSync(target)) {
    process.stdout.write(`${target} already exists - leaving it alone.\n\n`);
  } else {
    fs.writeFileSync(
      target,
      `${JSON.stringify(
        { $schema: './node_modules/testrix-cli/config.schema.json', projectId: '', apiKey: '' },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(
      `Wrote ${target}. Fill in projectId / apiKey, or set them as env vars.\n\n`,
    );
  }

  const provider = detectCiMetadata(process.env).provider;
  const snippet = CI_SNIPPETS[provider] || CI_SNIPPETS.ci;
  if (provider) {
    process.stdout.write(`Detected CI: ${provider}. Suggested step:\n\n`);
  } else {
    process.stdout.write('Not running in a recognised CI provider right now. A generic step:\n\n');
  }
  process.stdout.write(`${snippet.join('\n')}\n\n`);
  process.stdout.write('Everything else (branch, commit, environment, user) is auto-detected.\n');
}

async function main(argv) {
  if (argv[2] === 'init') {
    runInit();
    return 0;
  }

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

  const logFormat = parsed.flags['log-format'] || process.env.TESTRIX_LOG_FORMAT || 'text';
  if (logFormat && !['text', 'json'].includes(logFormat)) {
    throw new Error("--log-format must be 'text' or 'json'");
  }
  if (logFormat === 'json') log.useJsonFormat();

  reportsToOverrides(parsed.reports, parsed.overrides);
  if (parsed.flags['allow-insecure-url']) parsed.overrides.allowInsecureUrl = true;
  // Leaving configPath undefined (no -c / positional arg) lets loadConfig
  // search testrix.config.*/.testrixrc/package.json#testrix/config.json itself.
  const config = loadConfig(parsed.configPath, parsed.overrides);
  log.addSecret(config.apiKey); // never let the key reach a log line

  if (parsed.flags['print-config']) {
    const redacted = { ...config, apiKey: config.apiKey ? '***' : config.apiKey };
    process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
    return 0;
  }

  const debugBundlePath = parsed.flags['debug-bundle'];
  const debug = debugBundlePath
    ? {
        version,
        node: process.version,
        platform: process.platform,
        config: { ...config, apiKey: config.apiKey ? '***' : config.apiKey },
      }
    : null;
  const onEvent = debug
    ? (name, data) => {
        if (name === 'discover') debug.files = data.files;
        else if (name === 'parse')
          Object.assign(debug, { summary: data.summary, truncated: data.truncated });
        else if (name === 'upload:start') debug.uploadCount = data.count;
        else if (name === 'upload:done')
          Object.assign(debug, { testRunId: data.testRunId, url: data.url });
      }
    : undefined;

  let result;
  try {
    result = await publishTestReports(config, {
      dryRun: Boolean(parsed.flags['dry-run']),
      timeoutMs: num(parsed.flags.timeout, '--timeout'),
      retries: num(parsed.flags.retries, '--retries'),
      gzip: Boolean(parsed.flags.gzip),
      maxUploadBytes: parsed.flags.maxUploadBytes,
      onEvent,
    });
  } catch (err) {
    if (debug) writeDebugBundle(debugBundlePath, { ...debug, error: err.message });
    throw err;
  }
  if (debug) writeDebugBundle(debugBundlePath, { ...debug, timings: result.timings });

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
