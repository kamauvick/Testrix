'use strict';

const fs = require('node:fs');
const { toInt } = require('../limits');

// Above this size, sniffing falls back to a byte-window regex heuristic
// instead of a full JSON.parse (matches playwright-json.js's own streaming
// threshold - a file too big to sniff by parsing is also too big to buffer).
const sniffParseLimitBytes = () =>
  toInt(process.env.TESTRIX_JSON_STREAM_THRESHOLD_BYTES, 20 * 1024 * 1024);

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

/** Classify by *real* top-level keys - reliable, but needs the whole object. */
function classifyParsedJson(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'playwright';
  if (parsed.root_group && parsed.metrics) return 'k6';
  if (parsed.results && !Array.isArray(parsed.results) && typeof parsed.results === 'object') {
    return 'ctrf';
  }
  if (parsed.stats && Array.isArray(parsed.results)) return 'mochawesome';
  return 'playwright'; // covers real Playwright reports and any unrecognised shape
}

/**
 * Byte-window fallback for files too large to fully parse just to sniff. This
 * is regex-over-a-prefix, not a real top-level-only check, so a nested key can
 * produce a false substring match (e.g. Mochawesome's per-file
 * `results[].suites` contains the text `"suites":`, and Playwright's
 * per-attempt `test.results` contains the text `"results":`). Order goes from
 * most structurally unique signature to least, and Playwright - the one that
 * shares substrings with both of the others - is checked last with explicit
 * negative guards, on the assumption that a huge file is far more likely to be
 * the format known to reach that size (Playwright/JMeter) than the others.
 */
function classifyByHead(head) {
  if (/"root_group"\s*:/.test(head) && /"metrics"\s*:/.test(head)) return 'k6';
  if (/"results"\s*:\s*\{/.test(head) && /"tool"\s*:/.test(head)) return 'ctrf';
  if (
    /"suites"\s*:/.test(head) &&
    /"(config|stats|errors)"\s*:/.test(head) &&
    !/"results"\s*:\s*\[/.test(head)
  ) {
    return 'playwright';
  }
  if (/"stats"\s*:/.test(head) && /"results"\s*:\s*\[/.test(head)) return 'mochawesome';
  return 'playwright'; // preserves the previous default/error message for unrecognised JSON
}

/**
 * Which JSON test-report format a `.json` file is. Below the streaming
 * threshold this parses the whole file and checks real top-level keys
 * (reliable); above it, falls back to a regex heuristic on the first bytes
 * (cheap, but can be fooled by a nested key with the same name - see
 * {@link classifyByHead}).
 */
function sniffJsonFormat(filePath) {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    size = Infinity; // let the chosen parser's own file-read report the real error
  }

  if (size <= sniffParseLimitBytes()) {
    try {
      return classifyParsedJson(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch {
      // Not valid JSON (or a transient read error) - fall through to the
      // heuristic; whichever parser gets picked will report a clear error.
    }
  }
  return classifyByHead(peek(filePath, 16384));
}

module.exports = { peek, sniffXmlFormat, sniffJsonFormat };
