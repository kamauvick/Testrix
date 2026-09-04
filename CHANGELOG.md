# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Seven new report formats**, with content-based dispatch so `.xml`/`.json`
  work whichever tool produced them:
  - **TestNG** (`testng-results.xml` - Selenium-via-TestNG, WebdriverIO)
  - **NUnit3** XML (.NET / Selenium-with-NUnit)
  - **Mochawesome** JSON (Cypress's default reporter, or plain Mocha)
  - **CTRF** JSON (the emerging cross-runner format - Jest, Playwright, k6, ...)
  - **TAP** (`node --test`, `tap`, `pytest-tap`), streamed line-by-line
  - **k6** summary export - `checks` and metric `thresholds` become pass/fail
    cases, with the underlying values attached as `metrics`
  - **JMeter** `.jtl`, both CSV and XML, streamed and aggregated by sampler
    label (memory tracks unique labels, not sample count - these files are
    routinely gigabytes)
  - `.xml` is sniffed between JUnit/TestNG/NUnit3 by root element; `.json`
    between Playwright/k6/CTRF/Mochawesome by top-level keys; `.jtl` and `.tap`
    are dedicated extensions.
  - Test-case records gained an optional `metrics: {name, value, unit}[]` for
    load-tool data (not yet forwarded by `buildPayload` - no API column for it
    yet).

- **Playwright support.** Native parser for the `json` reporter and hardened
  handling of the `junit` reporter: projects/browsers (`hostname`), retries,
  flaky tests (`<flakyFailure>`), `[[ATTACHMENT|…]]` screenshot/video/trace
  markers, and detection of a crashed run (`errors="N"` with no test cases) so a
  broken run is never published green. A Playwright HTML report is rejected with
  guidance to enable `junit`/`json` instead.
- **Near-zero configuration.** Only `projectId` and `apiKey` are required. Report
  directories are auto-discovered (`test-results/`, `test-reports/`, `reports/`,
  `junit/`, `.`); `branch`, `commit`, `environment`, `name` and `userId` are read
  from the CI provider (GitHub Actions, GitLab CI, CircleCI, Jenkins, Bitbucket)
  or from `git`, then the OS user.
- **CLI flags:** `--project`, `--api-key`, `--reports` (repeatable, glob-aware),
  `--user`, `--env`, `--branch`, `--commit`, `--name`, `--url`, `--dashboard-url`,
  `--timeout`, `--retries`, `--output json`, `--dry-run`, `--fail-on-empty`,
  `--fail-on-failed`, `-c/--config`.
- **Resilient upload.** Per-attempt timeout, bounded retry with exponential
  backoff + jitter on transient failures (`5xx`/`429`/network), `Retry-After`
  support, `User-Agent`, and an `Idempotency-Key` per run.
- **Glob discovery** for `--reports` / `reportFiles` (`out/**/junit-*.xml`, `{a,b}.xml`).
- **`--output json`** emits `{ok, testRunId, url, published, summary, dryRun}` on
  stdout (logs move to stderr); a run URL is printed on success.
- **Exit-code gates:** `0` ok · `1` error · `2` `--fail-on-empty` · `3` `--fail-on-failed`.
- Run `startTime` / `endTime` are derived from the reports (JUnit `timestamp` +
  `time`, Playwright `stats`) rather than "now".
- `TODO.md` — hardening & scale roadmap.
- Repo scaffolding: CI matrix (Node 18/20/22 × Linux/Windows), release workflow
  with npm provenance, coverage gate, Dependabot, issue/PR templates,
  `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`, `docs/api-contract.md`.

### Changed

- **Streaming JUnit ingestion.** JUnit XML is now parsed with a streaming SAX
  reader (`saxes`, replacing `xml2js`) that never builds a DOM — peak memory is
  independent of report size, so multi-hundred-MB reports no longer OOM. A 132 MB
  / 1,000,000-case report parses in constant memory.
- **Bounded by default:** `errorMessage` / `errorStack` / `stdout` / `stderr` are
  clamped to 16 KB each (`TESTRIX_MAX_FIELD_BYTES`); total test cases are capped
  at 200,000 (`--max-cases` / `TESTRIX_MAX_CASES`, `0` = unlimited) with a warning
  when truncated.
- JUnit reports with colour codes / C0 control characters in attributes (default
  Playwright output) parse cleanly instead of hard-failing.
- **Streaming Playwright JSON ingestion.** Reports over 20 MB
  (`TESTRIX_JSON_STREAM_THRESHOLD_BYTES`) are parsed with `stream-json`, which
  assembles the `suites` array one spec file at a time instead of loading the
  whole document; smaller reports keep the simpler `JSON.parse` path.
- `.github/workflows/load-test.yml` (nightly + manual): generates a 1M-case
  JUnit report and a 200k-case Playwright JSON report, streams both through the
  real parsers, and fails if peak RSS exceeds a budget.
- JUnit `time` (seconds) is normalised to milliseconds so sub-second durations
  survive the integer rounding in the payload.
- ANSI colour codes are stripped from error messages, stacks and captured output.
- `cheerio` and `xlsx` are now `require`d lazily, only when an `.html` / `.xls(x)`
  report is actually parsed.

### Added (more formats)

- **`.trx`** (MSTest / `dotnet test --logger trx`): `src/parsers/trx.js`.
  Joins `<Results>` against `<TestDefinitions>` at end-of-stream, since the
  results section comes first in a standard `.trx` file.
- **`--output ctrf`**: parses the discovered reports and prints a CTRF
  document to stdout without publishing - Testrix now works as a one-shot
  converter into the cross-runner format, from any format it can read.
- A golden-output test locks down `buildPayload`'s exact shape for a fixed
  multi-project, mixed-result input.

### Added (observability & docs)

- `--log-format json`: one JSON object per line (`{level, msg, ts}`), scrubbed
  the same as text-mode logs.
- `--debug-bundle <path>`: a redacted JSON snapshot of a run (resolved config,
  discovered files, parse summary, timings, and the error on failure) for bug
  reports.
- `publishTestReports` / `createReporter().run()` results include
  `timings: { discoverMs, parseMs, uploadMs }`.
- `docs/ci-recipes.md`: copy-paste steps for GitHub Actions, GitLab, CircleCI,
  Jenkins, Bitbucket, plus publish-on-failure and gate-the-build notes.
- JUnit parsing hardened against a truncated/unclosed-tag file (rejected
  cleanly instead of hanging) and a megabyte-scale attribute value (clamped);
  `title`/`file`/`suite` now have their own 4 KB cap alongside the existing
  16 KB error/output cap.

### Added (config & DX)

- Config discovery, cosmiconfig-style: `testrix.config.{json,cjs,js}` →
  `.testrixrc(.json)` → a `testrix` key in `package.json`, walking up from cwd;
  falls back to the legacy `./config.json` unchanged.
- `testrix init` — scaffolds `testrix.config.json` and prints a CI snippet for
  the detected provider.
- `config.schema.json` for editor autocomplete (`"$schema"` in the config
  file, added automatically by `testrix init`).
- `--print-config` — the fully-resolved config, `apiKey` redacted.

### Added (programmatic API)

- `createReporter(config)` (`src/reporter.js`): an `EventEmitter`-based wrapper
  around `publishTestReports` for CI plugins / dashboards, emitting `discover`,
  `parse`, `upload:start`, `upload:done` (or `done` on a dry run).
- `publishTestReports` now returns `timings: { discoverMs, parseMs, uploadMs }`.
- `src/index.d.ts`: hand-written TypeScript definitions for the whole public
  API (`TestrixConfig`, `TestCaseRecord`, every `parseX`/`streamX` pair,
  `createReporter`, ...), wired via `package.json#types` and checked in CI
  (`npm run types:check`).
- `docs/architecture.md` and `docs/scaling.md`.

### Added (upload)

- `--gzip` (env `TESTRIX_GZIP`): compress the upload body, off by default until
  a server is confirmed to inflate `Content-Encoding: gzip`.
- `--max-upload-bytes` (env `TESTRIX_MAX_UPLOAD_BYTES`, default 20 MB): the
  body is checked against this cap _before_ sending, so an oversized run gets
  a clear local error instead of a slow upload followed by a 413.

### Security

- API key and `Authorization` values are redacted from logs and error messages;
  URL credentials are stripped before logging.
- `serverApiUrl` must be `https` unless it targets localhost or
  `--allow-insecure-url` / `TESTRIX_ALLOW_INSECURE_URL` is set.
- The JUnit parser rejects reports that declare DTD entity definitions
  (XML entity-expansion / billion-laughs guard).
- The upload no longer follows redirects blindly: a same-origin 307/308 is
  followed (preserving the POST body), a cross-origin redirect or a
  301/302/303 (which would leak the API key or silently drop the body) is
  refused with an explanation.
- `xlsx` moved to `optionalDependencies` (unpatched advisories, no upstream
  fix) so a default install is `npm audit --audit-level=high` clean; it loads
  lazily with an install hint if an `.xls`/`.xlsx` report is actually parsed.
- `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` are honoured via `undici`'s
  `ProxyAgent`, for uploads made from behind a corporate proxy.
- The report-file glob walker resolves symlinks and tracks visited real paths,
  so a symlink loop terminates instead of recursing forever.
- GitHub Action references are pinned to commit SHAs, not mutable tags.

### Fixed

_Found by a multi-angle `/code-review` pass over this branch's diff._

- **Mochawesome vs. Playwright JSON sniffing collided.** Both formats contain
  the byte-substring `"results":[` (Mochawesome's own `results` array,
  Playwright's per-attempt `test.results`), so the old prefix-regex sniffer
  could misclassify one as the other. `.json` files under the streaming
  threshold are now classified by actually `JSON.parse`-ing them and checking
  real top-level keys (`sniffJsonFormat` → `classifyParsedJson`); the regex
  heuristic is kept only as a documented fallback for files too large to parse
  just to sniff.
- **A `line: 0` attribute was silently turned into `line: null`** across
  JUnit, CTRF, and Playwright JSON parsing/writing (`X || null` treats `0` as
  falsy). Every site now uses `toInt(value, fallback)` or `Number.isFinite`
  instead, so a legitimate line 0 survives.
- **A `<error>` reported directly under a nested `<testsuite>` could be
  attributed to the wrong (ancestor) suite** if suites closed out of the naive
  order a flat error list assumed. JUnit's suite-level error tracking is now a
  stack of per-suite-level buckets (`_suiteErrorStack`), so a `</testsuite>`
  close only drains its own suite's errors, never an ancestor's.
- `--reports`/`reportFiles` override detection (`reportsToOverrides`) used a
  hand-maintained extension regex that had drifted from the real parser table
  and was missing `.trx`, `.jtl`, and `.tap`; it now checks the exported
  `REPORT_EXTENSIONS` set directly, so it can't drift again.
- `--debug-bundle` wrote its JSON snapshot without running it through the
  logger's secret redaction, unlike every other output path; it now calls
  `log.redact()` first.
- A sniff-time file-read failure inside `parseReports` could abort the whole
  run instead of being skipped and warned about, because `streamParserForFile`
  was called outside its own try/catch.
- An extensionless file sniffed as TestNG or NUnit (not just the JUnit
  fallback) that then failed to parse could abort the whole run instead of
  being skipped - `isSkippable`'s extensionless-file carve-out only checked
  for the JUnit streamer.
- `src/glob.js`'s `globToRegExp` threw a `SyntaxError` on a glob with an
  unbalanced `[` (treated as a literal now) and didn't support `[abc]` /
  `[!abc]` character classes at all; both now work.
- `src/parsers/html.js` and `excel.js` omitted `startTime`/`endTime` from
  their return value entirely, contradicting the `ParseResult` type in
  `src/index.d.ts`; both now explicitly return `null` for each.
- **Cleanup:** `makeCase()`, `asArray()`, the summary-accumulation snippet, and
  JUnit/NUnit's seconds-to-milliseconds conversion were each copy-pasted
  across 4–10 parser files; they now live once in `src/parsers/shared.js`
  (`makeCase`, `asArray`, `accumulate`, `secondsToMs`) and every parser
  imports them. TestNG's hand-rolled `STATUS_MAP` (which silently defaulted an
  unrecognised status to `passed`) is gone in favour of the same
  `normaliseStatus()` every other parser uses. JMeter's `.jtl` XML/CSV sniff
  now reuses `sniff.js`'s `peek()` instead of duplicating the file-peek logic.
- **CI:** the required `npm audit` job failed regardless of what triggered it,
  because `npm audit` reads the full dependency tree out of
  `package-lock.json` and ignores what `npm ci --omit=optional` actually
  installed - `xlsx`'s known, unfixed advisories were leaking into the
  "required" gate that was supposed to exclude them. `--omit=optional` is now
  passed to the `npm audit` command itself, not just the preceding `npm ci`.
- **CI:** `npm run format:check` failed on `test/fixtures/*.json` /
  `*.html` - real captured output from Playwright/k6/Mochawesome that's
  meant to stay byte-faithful to what those tools actually produce. Added
  `.prettierignore` covering `test/fixtures/` (and `package-lock.json`).

## [1.2.0]

- Baseline: parse JUnit / HTML / Excel reports and publish to the dashboard API.

[unreleased]: https://github.com/kamauvick/Testrix/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/kamauvick/Testrix/releases/tag/v1.2.0
