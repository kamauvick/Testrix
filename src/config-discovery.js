'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Searched, in this order, in each directory while walking up from cwd.
// `config.json` (the legacy default) is deliberately not walked up - it stays
// a cwd-only fallback so existing setups keep behaving exactly as before.
const CANDIDATES = [
  'testrix.config.json',
  'testrix.config.cjs',
  'testrix.config.js',
  '.testrixrc',
  '.testrixrc.json',
];

function loadJson(fullPath) {
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (err) {
    throw new Error(`Config file at ${fullPath} is not valid JSON: ${err.message}`);
  }
}

function loadCandidate(dir, name) {
  const full = path.join(dir, name);
  if (!fs.existsSync(full)) return undefined;
  if (name.endsWith('.js') || name.endsWith('.cjs')) {
    let mod;
    try {
      mod = require(full);
    } catch (err) {
      throw new Error(`Config file at ${full} could not be loaded: ${err.message}`);
    }
    return { path: full, config: (mod && mod.default) || mod || {} };
  }
  return { path: full, config: loadJson(full) };
}

/** A `testrix` key in `package.json`, if present and an object. */
function loadPackageJsonConfig(dir) {
  const full = path.join(dir, 'package.json');
  if (!fs.existsSync(full)) return undefined;
  let pkg;
  try {
    pkg = loadJson(full);
  } catch {
    return undefined; // not our file to validate if it's broken
  }
  if (pkg && pkg.testrix && typeof pkg.testrix === 'object' && !Array.isArray(pkg.testrix)) {
    return { path: `${full}#testrix`, config: pkg.testrix };
  }
  return undefined;
}

const MAX_WALK_UP = 50; // filesystem roots are reached long before this

/**
 * Walk up from `startDir` looking for a Testrix config file, cosmiconfig-style:
 * `testrix.config.{json,cjs,js}`, `.testrixrc(.json)`, or a `testrix` key in
 * `package.json`, checked in that order in each directory before moving up.
 * Does *not* look for the legacy `config.json` - see {@link CANDIDATES}.
 * @param {string} [startDir]
 * @returns {{ path: string, config: object } | null}
 */
function findConfigFile(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
    for (const name of CANDIDATES) {
      const found = loadCandidate(dir, name);
      if (found) return found;
    }
    const pkgConfig = loadPackageJsonConfig(dir);
    if (pkgConfig) return pkgConfig;

    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return null;
}

module.exports = { findConfigFile, CANDIDATES };
