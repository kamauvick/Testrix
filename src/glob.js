'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAGIC = /[*?[\]{}]/;
const toPosix = (p) => p.split(path.sep).join('/').replace(/\\/g, '/');

/** Does this pattern contain glob metacharacters? */
const isGlob = (pattern) => MAGIC.test(pattern);

const escapeRe = (s) => s.replace(/[.+^$()|\\]/g, '\\$&');

/** Convert a posix-style glob to an anchored RegExp. Supports `*`, `**`, `?`, `{a,b}`. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1; // `**/` also matches zero directories
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
      } else {
        const alts = glob
          .slice(i + 1, end)
          .split(',')
          .map(escapeRe)
          .join('|');
        re += `(?:${alts})`;
        i = end;
      }
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp(`^${re}$`);
}

/** Longest leading portion of an absolute posix path/glob with no glob magic. */
function staticBase(absGlob) {
  const segments = absGlob.split('/');
  const base = [];
  for (const seg of segments) {
    if (isGlob(seg)) break;
    base.push(seg);
  }
  return base.join('/') || '/';
}

/** Recursively list every file under `dir` (absolute paths); skips node_modules/.git. */
function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      out.push(...walk(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Expand one path pattern into absolute file paths. A pattern with no glob magic
 * is returned resolved (the caller checks existence).
 * @param {string} pattern
 * @param {string} [cwd]
 * @returns {string[]}
 */
function expand(pattern, cwd = process.cwd()) {
  if (!isGlob(pattern)) return [path.resolve(cwd, pattern)];

  const absGlob = toPosix(path.isAbsolute(pattern) ? pattern : path.resolve(cwd, pattern));
  const regexp = globToRegExp(absGlob);
  return walk(staticBase(absGlob))
    .filter((file) => regexp.test(toPosix(file)))
    .map((file) => path.resolve(file))
    .sort();
}

/** Expand many patterns, de-duplicated, order-preserving. */
function expandAll(patterns, cwd = process.cwd()) {
  const seen = new Set();
  for (const pattern of patterns) {
    for (const file of expand(pattern, cwd)) seen.add(file);
  }
  return [...seen];
}

module.exports = { isGlob, expand, expandAll };
