'use strict';

const { execFileSync } = require('node:child_process');

/**
 * Best-effort run metadata (branch / commit / name / userId / environment) so
 * users don't have to hand-fill CI-specific values. Everything here is optional:
 * a missing value just means that field stays unset.
 */

const clean = (value) => {
  const str = String(value || '').trim();
  return str.length > 0 ? str : undefined;
};

/** Read metadata from well-known CI provider environment variables. */
function detectCiMetadata(env = process.env) {
  // GitHub Actions
  if (env.GITHUB_ACTIONS) {
    const ref = env.GITHUB_HEAD_REF || (env.GITHUB_REF || '').replace(/^refs\/heads\//, '');
    return {
      provider: 'github',
      branch: clean(ref),
      commit: clean(env.GITHUB_SHA),
      name: clean(env.GITHUB_WORKFLOW),
      userId: clean(env.GITHUB_ACTOR),
    };
  }
  // GitLab CI
  if (env.GITLAB_CI) {
    return {
      provider: 'gitlab',
      branch: clean(env.CI_COMMIT_REF_NAME),
      commit: clean(env.CI_COMMIT_SHA),
      name: clean(env.CI_PIPELINE_NAME || env.CI_JOB_NAME),
      userId: clean(env.GITLAB_USER_EMAIL || env.GITLAB_USER_LOGIN),
      environment: clean(env.CI_ENVIRONMENT_NAME),
    };
  }
  // CircleCI
  if (env.CIRCLECI) {
    return {
      provider: 'circleci',
      branch: clean(env.CIRCLE_BRANCH),
      commit: clean(env.CIRCLE_SHA1),
      name: clean(env.CIRCLE_JOB),
      userId: clean(env.CIRCLE_USERNAME),
    };
  }
  // Jenkins
  if (env.JENKINS_URL || env.JENKINS_HOME) {
    return {
      provider: 'jenkins',
      branch: clean(env.GIT_BRANCH || env.BRANCH_NAME),
      commit: clean(env.GIT_COMMIT),
      name: clean(env.JOB_NAME),
    };
  }
  // Bitbucket Pipelines
  if (env.BITBUCKET_BUILD_NUMBER) {
    return {
      provider: 'bitbucket',
      branch: clean(env.BITBUCKET_BRANCH),
      commit: clean(env.BITBUCKET_COMMIT),
      name: clean(env.BITBUCKET_REPO_SLUG),
    };
  }
  // Generic / unknown CI
  return { provider: env.CI ? 'ci' : undefined };
}

let gitCache;

/** Read branch / commit / user.email straight from git. Cached per process. */
function detectGitMetadata() {
  if (gitCache) return gitCache;
  const git = (args) => {
    try {
      return clean(execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
    } catch {
      return undefined;
    }
  };
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  gitCache = {
    branch: branch === 'HEAD' ? undefined : branch, // detached checkout
    commit: git(['rev-parse', 'HEAD']),
    userId: git(['config', 'user.email']),
  };
  return gitCache;
}

module.exports = { detectCiMetadata, detectGitMetadata };
