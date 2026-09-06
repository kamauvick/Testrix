'use strict';

/**
 * Minimal leveled logger. Level is controlled by the TESTRIX_LOG_LEVEL env var
 * (silent | error | warn | info | debug); defaults to "info".
 *
 * `routeToStderr()` sends every level to stderr - used by `--output json` so
 * stdout carries only the machine-readable result. `addSecret()` registers a
 * value to be scrubbed from every line before it is written - `redact()`
 * applies that same scrubbing to text going somewhere other than a log line
 * (e.g. `--debug-bundle`'s JSON file). `useJsonFormat()` (`--log-format json`)
 * emits one JSON object per line instead of a plain `[testrix] message`, for
 * CI log processors.
 */
const { redactSecrets } = require('./redact');

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const threshold =
  LEVELS[String(process.env.TESTRIX_LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

let allToStderr = false;
let jsonFormat = false;
const secrets = new Set();

const scrub = (arg) =>
  typeof arg === 'string' ? (secrets.size > 0 ? redactSecrets(arg, secrets) : arg) : String(arg);

const emit = (level, stdoutSink, args) => {
  if (LEVELS[level] > threshold) return;
  const sink = allToStderr ? console.error : stdoutSink;
  const message = args.map(scrub).join(' ');
  if (jsonFormat) {
    sink(JSON.stringify({ level, msg: message, ts: new Date().toISOString() }));
  } else {
    sink(`[testrix] ${message}`);
  }
};

module.exports = {
  error: (...args) => emit('error', console.error, args),
  warn: (...args) => emit('warn', console.error, args),
  info: (...args) => emit('info', console.log, args),
  debug: (...args) => emit('debug', console.log, args),
  routeToStderr: () => {
    allToStderr = true;
  },
  useJsonFormat: () => {
    jsonFormat = true;
  },
  addSecret: (value) => {
    if (value) secrets.add(String(value));
  },
  /** Scrub every registered secret out of an arbitrary string. */
  redact: (text) => (secrets.size > 0 ? redactSecrets(text, secrets) : text),
};
