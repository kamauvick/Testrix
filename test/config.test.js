'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveConfig, loadConfig } = require('../src/config');
const { discoverReportFiles } = require('../src/publisher');
const { detectCiMetadata } = require('../src/ci');

/** Run `fn` with a patched environment, restoring it afterwards. */
function withEnv(patch, fn) {
  const saved = {};
  for (const key of Object.keys(patch)) {
    saved[key] = process.env[key];
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// Clear every provider/`TESTRIX_*` var a test might otherwise inherit from CI.
const CLEAN_ENV = {
  CI: undefined,
  GITHUB_ACTIONS: undefined,
  GITHUB_SHA: undefined,
  GITHUB_REF: undefined,
  GITHUB_HEAD_REF: undefined,
  GITHUB_ACTOR: undefined,
  GITHUB_WORKFLOW: undefined,
  GITLAB_CI: undefined,
  CIRCLECI: undefined,
  JENKINS_URL: undefined,
  BITBUCKET_BUILD_NUMBER: undefined,
  TESTRIX_PROJECT_ID: undefined,
  TESTRIX_API_KEY: undefined,
  TESTRIX_USER_ID: undefined,
  TESTRIX_BRANCH: undefined,
  TESTRIX_COMMIT: undefined,
  TESTRIX_ENVIRONMENT: undefined,
  TESTRIX_RUN_NAME: undefined,
  TESTRIX_REPORTS_DIR: undefined,
};

test('resolveConfig only requires projectId and apiKey; userId is auto-filled', () => {
  withEnv(CLEAN_ENV, () => {
    assert.throws(() => resolveConfig({}), /Missing required config: projectId, apiKey/);

    const config = resolveConfig({ projectId: 'p1', apiKey: 'k1' });
    assert.equal(config.projectId, 'p1');
    assert.equal(config.apiKey, 'k1');
    assert.ok(config.userId, 'userId defaulted from git/OS');
    assert.equal(
      config.serverApiUrl,
      'https://testing-dashboard-api.myworkpay.com/api/submit-test-reports',
    );
  });
});

test('resolveConfig fills branch / commit / user / name from GitHub Actions env', () => {
  withEnv(
    {
      ...CLEAN_ENV,
      GITHUB_ACTIONS: 'true',
      GITHUB_SHA: 'deadbeef',
      GITHUB_REF: 'refs/heads/feature/x',
      GITHUB_ACTOR: 'octocat',
      GITHUB_WORKFLOW: 'CI',
      TESTRIX_PROJECT_ID: 'p1',
      TESTRIX_API_KEY: 'k1',
    },
    () => {
      const config = resolveConfig({});
      assert.equal(config.branch, 'feature/x');
      assert.equal(config.commit, 'deadbeef');
      assert.equal(config.userId, 'octocat');
      assert.equal(config.name, 'CI');
    },
  );
});

test('explicit config values beat CI env', () => {
  withEnv(
    { ...CLEAN_ENV, GITHUB_ACTIONS: 'true', GITHUB_SHA: 'fromci', TESTRIX_API_KEY: 'k1' },
    () => {
      const config = resolveConfig({ projectId: 'p1', commit: 'fromfile' });
      assert.equal(config.commit, 'fromfile');
    },
  );
});

test('loadConfig works with no file and merges CLI overrides at highest precedence', () => {
  withEnv({ ...CLEAN_ENV, TESTRIX_PROJECT_ID: 'env-proj', TESTRIX_API_KEY: 'env-key' }, () => {
    const config = loadConfig(undefined, { projectId: 'cli-proj', environment: 'staging' });
    assert.equal(config.projectId, 'cli-proj');
    assert.equal(config.apiKey, 'env-key');
    assert.equal(config.environment, 'staging');
  });
});

test('loadConfig ignores an absent default config.json but rejects an absent explicit path', () => {
  withEnv({ ...CLEAN_ENV, TESTRIX_PROJECT_ID: 'p', TESTRIX_API_KEY: 'k' }, () => {
    assert.doesNotThrow(() => loadConfig('config.json'));
    assert.throws(() => loadConfig('./definitely-missing.json'), /Config file not found/);
  });
});

test('resolveConfig requires https for a remote serverApiUrl', () => {
  withEnv({ ...CLEAN_ENV, TESTRIX_PROJECT_ID: 'p', TESTRIX_API_KEY: 'k' }, () => {
    assert.throws(
      () => resolveConfig({ serverApiUrl: 'http://reports.example.com/api' }),
      /must use https/,
    );
    // localhost is exempt (local dev / tests)
    assert.doesNotThrow(() => resolveConfig({ serverApiUrl: 'http://127.0.0.1:3000/api' }));
    // explicit opt-out for a trusted host
    assert.doesNotThrow(() =>
      resolveConfig({ serverApiUrl: 'http://reports.example.com/api', allowInsecureUrl: true }),
    );
  });
});

test('detectCiMetadata recognises GitLab CI', () => {
  const meta = detectCiMetadata({
    GITLAB_CI: 'true',
    CI_COMMIT_REF_NAME: 'main',
    CI_COMMIT_SHA: 'abc123',
    CI_ENVIRONMENT_NAME: 'production',
  });
  assert.equal(meta.provider, 'gitlab');
  assert.equal(meta.branch, 'main');
  assert.equal(meta.environment, 'production');
});

test('discoverReportFiles auto-discovers a candidate reports directory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'testrix-'));
  fs.mkdirSync(path.join(tmp, 'test-results'));
  fs.copyFileSync(
    path.join(__dirname, 'fixtures', 'vitest-junit.xml'),
    path.join(tmp, 'test-results', 'results.xml'),
  );
  const cwd = process.cwd();
  try {
    process.chdir(tmp);
    const files = discoverReportFiles({});
    assert.equal(files.length, 1);
    assert.match(files[0], /results\.xml$/);
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('discoverReportFiles gives an actionable error when nothing is found', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'testrix-empty-'));
  const cwd = process.cwd();
  try {
    process.chdir(tmp);
    assert.throws(() => discoverReportFiles({}), /No test reports found/);
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
