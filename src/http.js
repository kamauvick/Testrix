'use strict';

const { randomUUID } = require('node:crypto');

const log = require('./logger');
const { version } = require('../package.json');

const USER_AGENT = `testrix-cli/${version} node/${process.versions.node.replace(/^v/, '')} ${process.platform}`;

// Transient HTTP statuses worth retrying.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter, capped; honours a numeric `Retry-After`. */
function backoffMs(attempt, retryAfter, overrideMs) {
  if (overrideMs !== undefined) return Math.max(0, Number(overrideMs) || 0);
  if (retryAfter != null && retryAfter !== '') {
    const headerSecs = Number(retryAfter);
    if (Number.isFinite(headerSecs) && headerSecs >= 0) return Math.min(headerSecs * 1000, 30_000);
  }
  return Math.min(500 * 2 ** (attempt - 1), 15_000) + Math.floor(Math.random() * 250);
}

const isNetworkError = (err) =>
  err &&
  (err.name === 'TimeoutError' ||
    err.name === 'AbortError' ||
    err.code === 'ECONNRESET' ||
    err.code === 'ECONNREFUSED' ||
    err.code === 'ENOTFOUND' ||
    err.code === 'EAI_AGAIN' ||
    err.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    /fetch failed|network|socket hang up/i.test(err.message || ''));

/**
 * POST `payload` to the dashboard API with a timeout, a bounded retry loop for
 * transient failures, a `User-Agent`, and an `Idempotency-Key` so a retried
 * request never creates a duplicate run.
 * @returns {Promise<{ testRunId?: string, raw: any }>}
 */
async function submitReport(config, payload, options = {}) {
  const attempts = Math.max(1, Number(options.retries ?? process.env.TESTRIX_UPLOAD_RETRIES ?? 4));
  const timeoutMs = Math.max(
    1000,
    Number(options.timeoutMs ?? process.env.TESTRIX_UPLOAD_TIMEOUT_MS ?? 30_000),
  );
  const retryDelayMs = options.retryDelayMs; // tests only - skip the real backoff wait
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': config.apiKey,
    'User-Agent': USER_AGENT,
    'Idempotency-Key': randomUUID(),
  };

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(config.serverApiUrl, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) {
        const raw = await response.json().catch(() => ({}));
        return { testRunId: raw.testRunId || raw.id || raw.runId, raw };
      }

      const text = await response.text().catch(() => '');
      lastError = new Error(
        `Server responded ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`,
      );
      if (attempt >= attempts || !RETRYABLE_STATUS.has(response.status)) throw lastError;
      const wait = backoffMs(attempt, response.headers.get('retry-after'), retryDelayMs);
      log.warn(
        `Upload attempt ${attempt}/${attempts} failed (HTTP ${response.status}); retrying in ${wait}ms`,
      );
      await sleep(wait);
    } catch (err) {
      if (err === lastError) throw err; // non-retryable HTTP error, already reported
      if (!isNetworkError(err) || attempt >= attempts) throw err;
      lastError = err;
      const wait = backoffMs(attempt, undefined, retryDelayMs);
      log.warn(
        `Upload attempt ${attempt}/${attempts} failed (${err.message || err.name}); retrying in ${wait}ms`,
      );
      await sleep(wait);
    }
  }
  throw lastError;
}

/**
 * Best-effort URL of the run's page in the dashboard UI. Uses `dashboardUrl`
 * when provided, otherwise derives the web host from the API host by dropping a
 * leading `api.` / trailing `-api` token.
 * @returns {string | undefined}
 */
function deriveRunUrl(serverApiUrl, testRunId, dashboardUrl) {
  if (!testRunId) return undefined;
  if (dashboardUrl) return `${String(dashboardUrl).replace(/\/+$/, '')}/test-runs/${testRunId}`;
  try {
    const api = new URL(serverApiUrl);
    const host = api.host.replace(/^api\./, '').replace(/-api(?=\.|:|$)/, '');
    if (host === api.host) return undefined; // couldn't tell the web host apart
    return `${api.protocol}//${host}/test-runs/${testRunId}`;
  } catch {
    return undefined;
  }
}

module.exports = { submitReport, deriveRunUrl, backoffMs, USER_AGENT };
