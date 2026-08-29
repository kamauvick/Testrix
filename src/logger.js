'use strict';

/**
 * Minimal leveled logger. Level is controlled by the TESTRIX_LOG_LEVEL env var
 * (silent | error | warn | info | debug); defaults to "info".
 */
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const threshold =
  LEVELS[String(process.env.TESTRIX_LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

const emit = (level, sink, args) => {
  if (LEVELS[level] <= threshold) sink('[testrix]', ...args);
};

module.exports = {
  error: (...args) => emit('error', console.error, args),
  warn: (...args) => emit('warn', console.error, args),
  info: (...args) => emit('info', console.log, args),
  debug: (...args) => emit('debug', console.log, args),
};
