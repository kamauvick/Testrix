'use strict';

const fs = require('node:fs');

/** Read the first `n` bytes of a file as utf8, without loading the whole thing. */
function peek(filePath, n = 16384) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const len = fs.readSync(fd, buf, 0, n, 0);
    return buf.toString('utf8', 0, len);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Which XML test-report dialect a `.xml` (or extensionless) file is, from its
 * root element - cheap enough to do even on a huge file since we only read a
 * few KB, and reliable since the root element always appears at the very start.
 */
function sniffXmlFormat(filePath) {
  const head = peek(filePath, 4096);
  if (/<testng-results\b/i.test(head)) return 'testng';
  if (/<test-run\b/i.test(head) && !/<testsuite\b/i.test(head)) return 'nunit';
  return 'junit';
}

/**
 * Which JSON test-report format a `.json` file is, from its top-level keys.
 * Peeking (rather than a full `JSON.parse`) keeps this cheap for a huge report
 * that a size-gated parser (Playwright) would otherwise stream; top-level keys
 * appear near the start of the file regardless of how large their values are.
 */
function sniffJsonFormat(filePath) {
  const head = peek(filePath, 16384);
  if (/"root_group"\s*:/.test(head) && /"metrics"\s*:/.test(head)) return 'k6';
  if (/"suites"\s*:/.test(head) && /"(config|stats|errors)"\s*:/.test(head)) return 'playwright';
  if (/"results"\s*:\s*\{/.test(head) && /"tool"\s*:/.test(head)) return 'ctrf';
  if (/"stats"\s*:/.test(head) && /"results"\s*:\s*\[/.test(head)) return 'mochawesome';
  return 'playwright'; // preserves the previous default/error message for unrecognised JSON
}

module.exports = { peek, sniffXmlFormat, sniffJsonFormat };
