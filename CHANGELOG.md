# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

## [1.2.0]

- Baseline: parse JUnit / HTML / Excel reports and publish to the dashboard API.

[unreleased]: https://github.com/kamauvick/Testrix/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/kamauvick/Testrix/releases/tag/v1.2.0
