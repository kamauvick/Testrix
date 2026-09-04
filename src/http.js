'use strict';

const { randomUUID } = require('node:crypto');
const zlib = require('node:zlib');
const { fetch: undiciFetch, ProxyAgent } = require('undici');

const log = require('./logger');
const { redactUrl } = require('./redact');
const { version } = require('../package.json');

const USER_AGENT = `testrix-cli/${version} node/${process.versions.node.replace(/^v/, '')} ${process.platform}`;

// Transient HTTP statuses worth retrying.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A `dispatcher` for `fetch()` that routes through `HTTPS_PROXY`/`HTTP_PROXY`
 * when set and the target host isn't listed in `NO_PROXY`. `undici` is used
 * explicitly (rather than relying on the global dispatcher) so proxy behaviour
 * doesn't depend on Node's internal undici version.
 */
function proxyDispatcher(targetUrl) {
  const env = process.env;
  const noProxy = (env.NO_PROXY || env.no_proxy || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const host = targetUrl.hostname.toLowerCase();
  if (noProxy.some((n) => host === n || host.endsWith(`.${n}`))) return undefined;

  const proxyUrl =
    targetUrl.protocol === 'https:'
      ? env.HTTPS_PROXY || env.https_proxy
      : env.HTTP_PROXY || env.http_proxy;
  if (!proxyUrl) return undefined;
  return new ProxyAgent(proxyUrl);
}

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
 * POST once, following same-origin redirects ourselves (rather than letting
 * fetch do it silently) so a redirect to another host - which would otherwise
 * carry the API key along with it - is refused instead of followed.
 */
async function postFollowingSameOriginRedirects(startUrl, init) {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const target = new URL(url);
    const response = await undiciFetch(url, {
      ...init,
      redirect: 'manual',
      dispatcher: proxyDispatcher(target),
    });
    if (!REDIRECT_STATUS.has(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) return response; // malformed redirect - let the caller treat the status as an error
    const next = new URL(location, url);
    if (next.origin !== target.origin) {
      throw new Error(
        `Refusing to follow a cross-origin redirect from ${redactUrl(url)} to ` +
          `${redactUrl(next.toString())} (would send the API key to another host). ` +
          'Point serverApiUrl at the final destination if this is expected.',
      );
    }
    if (response.status !== 307 && response.status !== 308) {
      throw new Error(
        `${redactUrl(url)} redirected (HTTP ${response.status}) to ${redactUrl(next.toString())}, ` +
          'which would drop the request body. Point serverApiUrl at the final destination instead.',
      );
    }
    log.info(`Following redirect (HTTP ${response.status}) to ${redactUrl(next.toString())}`);
    url = next.toString();
  }
  throw new Error(`Too many redirects (> ${MAX_REDIRECTS}) from ${redactUrl(startUrl)}`);
}

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));

/**
 * POST `payload` to the dashboard API with a timeout, a bounded retry loop for
 * transient failures, a `User-Agent`, and an `Idempotency-Key` so a retried
 * request never creates a duplicate run. Routes through `HTTPS_PROXY` /
 * `HTTP_PROXY` when set, and refuses to silently follow a cross-origin redirect.
 *
 * The body is checked against a hard size cap *before* sending - a run large
 * enough to trip a server body-size limit gets a clear, local error instead of
 * a cryptic 413 after a slow upload. Enable `--gzip` once your server is
 * confirmed to inflate `Content-Encoding: gzip` (not on by default - see
 * docs/api-contract.md).
 * @returns {Promise<{ testRunId?: string, raw: any }>}
 */
async function submitReport(config, payload, options = {}) {
  const attempts = Math.max(1, Number(options.retries ?? process.env.TESTRIX_UPLOAD_RETRIES ?? 4));
  const timeoutMs = Math.max(
    1000,
    Number(options.timeoutMs ?? process.env.TESTRIX_UPLOAD_TIMEOUT_MS ?? 30_000),
  );
  const gzipEnabled = Boolean(options.gzip ?? truthy(process.env.TESTRIX_GZIP));
  const maxUploadBytes = Math.max(
    1,
    Number(options.maxUploadBytes ?? process.env.TESTRIX_MAX_UPLOAD_BYTES ?? 20 * 1024 * 1024),
  );
  const retryDelayMs = options.retryDelayMs; // tests only - skip the real backoff wait

  const json = JSON.stringify(payload);
  const body = gzipEnabled ? zlib.gzipSync(json) : json;
  const bodyBytes = Buffer.byteLength(body);
  if (bodyBytes > maxUploadBytes) {
    throw new Error(
      `Upload body is ${(bodyBytes / 1e6).toFixed(1)}MB, over the configured ` +
        `${(maxUploadBytes / 1e6).toFixed(1)}MB limit (--max-upload-bytes / TESTRIX_MAX_UPLOAD_BYTES). ` +
        `Reduce the run with --max-cases${gzipEnabled ? '' : ', or enable --gzip to compress the body'}.`,
    );
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': config.apiKey,
    'User-Agent': USER_AGENT,
    'Idempotency-Key': randomUUID(),
  };
  if (gzipEnabled) headers['Content-Encoding'] = 'gzip';

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await postFollowingSameOriginRedirects(config.serverApiUrl, {
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

module.exports = { submitReport, deriveRunUrl, backoffMs, proxyDispatcher, USER_AGENT };
