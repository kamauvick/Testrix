'use strict';

/**
 * Minimal leveled logger. Level is controlled by the TESTRIX_LOG_LEVEL env var
 * (silent | error | warn | info | debug); defaults to "info".
 *
 * `routeToStderr()` sends every level to stderr - used by `--output json` so
 * stdout carries only the machine-readable result. `addSecret()` registers a
 * value to be scrubbed from every line before it is written.
 */
const { redactSecrets } = require('./redact');

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const threshold =
  LEVELS[String(process.env.TESTRIX_LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

let allToStderr = false;
const secrets = new Set();

const scrub = (arg) =>
  typeof arg === 'string' && secrets.size > 0 ? redactSecrets(arg, secrets) : arg;

const emit = (level, stdoutSink, args) => {
  if (LEVELS[level] > threshold) return;
  const sink = allToStderr ? console.error : stdoutSink;
  sink('[testrix]', ...args.map(scrub));
};

module.exports = {
  error: (...args) => emit('error', console.error, args),
  warn: (...args) => emit('warn', console.error, args),
  info: (...args) => emit('info', console.log, args),
  debug: (...args) => emit('debug', console.log, args),
  routeToStderr: () => {
    allToStderr = true;
  },
  addSecret: (value) => {
    if (value) secrets.add(String(value));
  },
};
