#!/usr/bin/env node
'use strict';

const { version } = require('./package.json');
const log = require('./src/logger');
const { loadConfig } = require('./src/config');
const { publishTestReports } = require('./src/publisher');

const HELP = `testrix v${version}

Parse JUnit, HTML and Excel test reports and publish them to a Testrix dashboard API.

Usage:
  testrix [path/to/config.json]

Arguments:
  config path    Path to the config file (default: ./config.json)

Options:
  -h, --help     Show this help
  -v, --version  Show the version

Environment:
  TESTRIX_SERVER_API_URL   Override serverApiUrl
  TESTRIX_PROJECT_ID       Provide projectId
  TESTRIX_API_KEY          Provide apiKey
  TESTRIX_LOG_LEVEL        silent | error | warn | info (default) | debug
`;

async function main(argv) {
  const args = argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.includes('-v') || args.includes('--version')) {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  const configPath = args.find((arg) => !arg.startsWith('-')) || 'config.json';
  log.info(`Reading config from ${configPath}`);
  const config = loadConfig(configPath);

  // A successful publish exits 0 even when some tests failed - the failure
  // count is reported in the logs and surfaced on the dashboard.
  await publishTestReports(config);
  return 0;
}

main(process.argv)
  .then((code) => process.exit(code))
  .catch((err) => {
    log.error(err.message);
    if (process.env.TESTRIX_LOG_LEVEL === 'debug' && err.stack) log.debug(err.stack);
    process.exit(1);
  });
