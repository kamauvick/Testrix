# Testrix CLI — hardening & scale roadmap

Bring the CLI to production-grade engineering standards, make it upload a test
run of **any size** — from 10 tests to 1,000,000 — in bounded memory and time,
and make it speak the formats the industry actually produces (functional **and**
load/perf tooling).

> **Progress:** **E1, E2a, E3 (bar a parser registry), E4, E5, E7, E8 (bar schema-validation errors), E10 (bar a progress line) done.**
> **E9/E9b: 8 new formats shipped** — TestNG, NUnit3, `.trx`, Mochawesome, CTRF (in + out, `--output ctrf`), TAP, k6, JMeter (CSV+XML) — with content-sniffed dispatch for the ambiguous extensions. Robot Framework, Gatling, Locust, and a real-tool dialect-conformance suite remain.
> **E6:** coverage gate, nightly load test, a golden-file test for `buildPayload`, and fuzz-ish JUnit robustness (truncated file, huge attribute, DTD entities) are done; fixtures generated from real tool installs (rather than hand-written) are still open.
> **E11:** architecture/scaling/CI-recipe docs done; a physical README split and an `adr/` folder are still open.
> **E0** contract doc is written but its answers are still owed by the API team - **E2** (the batched/resumable protocol) is blocked on them; E2a (gzip + size cap) shipped in the meantime.

## Definition of done for "scales regardless of upload size"

- [x] **Parsing** is O(batch), not O(report) — verified for JUnit and (above a size threshold) Playwright JSON. **Uploading** is not yet — `parseReports` still fills one array for a single POST, bounded only by `--max-cases`; true O(batch) upload is E2.
- [x] A **1 GB** JUnit XML file parses without OOM (streaming, not `readFileSync` + DOM) — measured at 132 MB / 1,000,000 cases with ≈0 MB RSS growth; see `docs/scaling.md`.
- [ ] **1,000,000** test cases upload successfully, resumably, in bounded memory — blocked on E2 (resumability needs a batched protocol; today it's one request, capped and optionally gzipped).
- [x] No single HTTP request body exceeds a configured limit — `--max-upload-bytes` (default 20 MB) refuses an oversized body locally; `--gzip` is available once a server confirms it inflates the encoding. Not yet _automatically_ batched down to "a few MB" - that's E2.
- [ ] Wall-clock budget: ≤ ~5 min for 1M cases on a standard 2-CPU CI runner — parsing alone measures ~4s for 1M JUnit cases; end-to-end (incl. upload) at that scale isn't measured yet since it depends on the server and whether `--max-cases`/`--gzip` are tuned for it.
- [ ] A nightly load test in CI enforces the RSS and time budgets with synthetic 100k / 1M fixtures.

---

## E0 — Verify the current API contract · P0 · S · _blocks everything_

Everything below assumes a known server contract. The `dashboard-api` repo's
`/api/submit-test-reports` handler reads a **flat legacy shape**; the CLI sends
`{ testRun, testCases }`. Confirm what prod actually accepts before building on it.

- [ ] Confirm prod request schema and required fields.
- [ ] Confirm success response body (is the id field `testRunId`, `id`, `runId`?).
- [ ] Confirm status codes for auth failure, validation failure, rate limit.
- [ ] Confirm max request body size and whether the server inflates `Content-Encoding: gzip`.
- [x] Write it down in `docs/api-contract.md`. _(open questions listed there; answers still owed by API owners)_
- [ ] Add a contract test against a recorded fixture.

## E1 — Streaming, bounded-memory ingestion · P0 · L

- [x] Replace `xml2js` + `fs.readFileSync` with a streaming SAX parser — `saxes`, DOM-free, chunk-sanitised for control chars / ANSI.
- [x] Streaming contract: `streamJUnit(file, acc)` async generator yields one record at a time; `parseReports` consumes the stream. Buffered formats adapted via `bufferedToStream`. `parseJUnit` kept as a drain-to-array convenience wrapper.
- [x] Per-field cap: `errorMessage` / `errorStack` / `stdout` / `stderr` clamped to 16 KB (`TESTRIX_MAX_FIELD_BYTES`) with a `…[truncated]` marker.
- [x] `--max-cases` ceiling (default 200k, `0` = unlimited): warn + stop reading. `test/junit-stream.test.js` covers it. Verified: 132 MB / 1M-case report parses in constant memory (Δ≈0 MB).
- [x] **Playwright JSON streaming** — above 20 MB (`TESTRIX_JSON_STREAM_THRESHOLD_BYTES`), `stream-json` assembles the `suites` array one spec-file at a time instead of `JSON.parse`-ing the whole document; `errors`/`stats` (always tiny) are read in full off the same token stream. Below the threshold it's still plain `JSON.parse` - simpler and just as correct for the common case.
- [x] Excel/HTML: documented the "loads whole file" ceiling in `docs/scaling.md`.
- [x] CI: `.github/workflows/load-test.yml` (nightly + manual) runs `scripts/load-test.js` - generates a 1M-case JUnit file and a 200k-case Playwright JSON file, streams both, and fails the job if peak RSS exceeds a budget (default 700 MB).

## E2 — Chunked, resumable upload protocol v2 · P0 · L · _needs API_

- [ ] RFC to the `dashboard-api` team: `POST /runs` (create → id) → `POST /runs/:id/cases` in batches → `POST /runs/:id/complete` (summary + start/end time).
- [ ] Batch size default 500; gzip each body; per-batch `Idempotency-Key` + batch index.
- [ ] Bounded concurrency for batch POSTs (default 4–6 in flight) with backpressure from the parse stream.
- [ ] Resumability: persist acked batch indices to `.testrix/state-<runId>.json`; `--resume` re-sends only the gap. Idempotency keys make re-sends safe with or without the state file.
- [ ] Feature-probe (or `--legacy-upload`): fall back to a single POST **with a hard size cap** and a clear over-cap error.
- [x] **E2a (shipped, no API dep):** `--gzip` (opt-in, off by default until a server confirms it inflates `Content-Encoding: gzip` - see `docs/api-contract.md`) and a hard client-side `--max-upload-bytes` cap (default 20 MB) that rejects an oversized body _before_ sending it, with a clear message pointing at `--max-cases` / `--gzip`. Reuses the retry/backoff in `src/http.js`.
- [ ] Test: 1M-case upload against a mock server; kill mid-upload, `--resume`, no duplicates.

## E3 — Architecture & module boundaries · P1 · M

- [x] Already split into `discover → parse (stream) → transform → transport` (`discoverReportFiles` / `streamParserForFile` / `buildPayload` / `submitReport`), each independently testable and documented in `docs/architecture.md`.
- [x] `createReporter(config)` — `{ on(event, handler), run(options) }`, wraps `publishTestReports`'s new `onEvent` hook in an `EventEmitter` (`discover`/`parse`/`upload:start`/`upload:done`/`done`). `publishTestReports` also now returns `timings: {discoverMs, parseMs, uploadMs}`.
- [x] `TestCaseRecord` documented in `src/index.d.ts` and `docs/architecture.md`; hand-written `.d.ts` for the whole public API, type-checked in CI (`npm run types:check`).
- [ ] Parser registry so third-party formats can self-register — not done; every format is still built-in (`src/parsers/index.js`'s dispatch tables). Fine while all formats ship in-tree; would matter if third parties want to add their own.

## E4 — Supply chain & dependencies · P0 · M

- [x] Drop `xml2js` (maintenance-only, prior prototype-pollution CVE) — replaced by `saxes` (E1).
- [ ] `xlsx@0.18.5` is the last npm-registry SheetJS release and carries unpatched advisories (`npm audit` flags it forever). Move Excel to `exceljs` (streaming, maintained) **and/or** `optionalDependencies`.
- [x] Lazy-`require` `cheerio` and `xlsx` — loaded only when an `.html` / `.xls(x)` file is parsed; `xlsx` moved to `optionalDependencies` with a clear install-hint error when it's missing.
- [x] `package-lock.json` committed; `npm ci` in CI.
- [x] `npm publish --provenance` (release workflow).
- [x] `npm audit --audit-level=high` is a **real, required gate** now (`npm ci --omit=optional`, so `xlsx`'s unfixed advisories don't block it); `xlsx` itself is audited separately as a non-blocking warning.
- [x] `engine-strict=true` in `.npmrc`; GitHub Action refs pinned to commit SHAs (checkout, setup-node, action-gh-release).

## E5 — CI / release engineering · P0 · M

- [x] `.github/workflows/ci.yml`: lint + format check + `npm test` + coverage + `npm audit`, matrix Node 18.18/20/22 on Linux **and Windows**.
- [x] `release.yml`: on tag → `npm publish --provenance` + GitHub release, with a tag/version guard.
- [x] `CHANGELOG.md` (Keep a Changelog); `1.2.0 → Unreleased` delta captured.
- [x] `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`, `CODE_OF_CONDUCT.md`, issue/PR templates.
- [x] Dependabot config (npm + github-actions).
- [ ] Conventional Commits + commitlint (optional).

## E6 — Testing & quality gates · P1 · M

- [x] Coverage via `c8` with an enforced floor (`test:coverage`: lines 80 / functions 80 / branches 70; currently ~87 / ~91 / ~74).
- [ ] Replace hand-written fixtures with **real** output from Playwright, Vitest, jest-junit, Pest/PHPUnit, pytest, Cypress, TestNG, `dotnet test` (.trx), Robot Framework, k6, JMeter (see E9 / E9b).
- [x] Fuzz-ish coverage of the JUnit stream parser: unclosed root tag (rejected cleanly, doesn't hang), a 1MB attribute value (clamped, doesn't bloat the record), entity-expansion / billion-laughs (rejected - `test/junit-stream.test.js`). Not a property-based fuzzer; a handful of targeted adversarial fixtures.
- [x] Nightly load test: synthetic 100k / 1M generators, assert peak RSS + wall time (E1: `.github/workflows/load-test.yml`).
- [x] A golden-output test for `buildPayload` (`test/parsers.test.js`) - a fixed multi-project mixed-result input asserted against a fully hard-coded expected payload. Not per-fixture `--dry-run` snapshots for every format yet.
- [x] Multi-angle `/code-review` pass over this branch's diff, findings fixed: a Mochawesome/Playwright JSON sniff collision, `line: 0` silently becoming `null` in three parsers, cross-suite JUnit error misattribution, a stale `reportsToOverrides` extension regex, an unredacted `--debug-bundle`, a sniff failure that could abort a whole run instead of skipping one file, `globToRegExp` rejecting `[...]` character classes, `html`/`excel` parsers omitting `startTime`/`endTime`, and duplicated `makeCase`/`asArray`/accumulation/seconds-to-ms helpers consolidated into `src/parsers/shared.js`. Full detail in `CHANGELOG.md`'s Fixed section.

## E7 — Security hardening · P1 · M

- [x] `apiKey` scrubbed from every log line (`logger.addSecret`); `redactUrl` strips URL credentials before logging. Regression test in `test/redact.test.js`.
- [x] `serverApiUrl` must be `https` unless localhost or `--allow-insecure-url` / `TESTRIX_ALLOW_INSECURE_URL`. Test in `test/config.test.js`.
- [x] Upload redirects are followed manually: same-origin 307/308 (preserves the POST body) is followed; a cross-origin redirect or a 301/302/303 (which would leak the key or drop the body) is refused with a clear error.
- [x] Glob walker: guards against symlink cycles (realpath-tracked); now also correctly walks symlinked files/dirs it previously silently skipped.
- [ ] With `--root` set, refuse report paths that resolve outside it (glob walker doesn't yet take a root boundary).
- [x] XML: `saxes` does not resolve external entities; JUnit reports declaring DTD entities are rejected outright. Billion-laughs test in `test/junit-stream.test.js`.
- [x] Proxy support via `undici` `ProxyAgent`, honouring `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`.

## E8 — Config & DX · P2 · M

- [x] cosmiconfig-style discovery (`src/config-discovery.js`): `testrix.config.{json,cjs,js}` → `.testrixrc(.json)` → a `testrix` key in `package.json`, walking up from cwd; falls back to the legacy `config.json` (cwd-only, not walked up - unchanged behaviour for existing setups).
- [x] `config.schema.json` shipped for editor autocomplete (`$schema` key in the config file). **Not done:** runtime validation against it with a path-naming error — currently only `projectId`/`apiKey`/`reportFiles`/`serverApiUrl` shape are checked (in `resolveConfig`); an unrecognised key is silently ignored rather than flagged.
- [x] `testrix init` — writes `testrix.config.json` (refuses to overwrite an existing one) and prints a CI snippet for the detected provider (GitHub/GitLab/CircleCI/Jenkins/Bitbucket/generic).
- [x] `.d.ts` for the programmatic API — shipped in E3.
- [x] `--print-config` — resolved config, `apiKey` redacted to `***`.

## E9 — Format coverage: functional test frameworks · P1 · L

Goal: ingest what the industry actually emits, not just the three formats we
started with. Most tools below can emit JUnit XML, but every generator's dialect
differs — build a **JUnit conformance suite** and add native parsers only where
JUnit loses information.

- [ ] **JUnit dialect conformance:** real fixtures + tests for jest-junit, pytest (`--junitxml`), Surefire/Failsafe (Java), rspec_junit_formatter, Cypress (`mocha-junit-reporter`), WebdriverIO, Karma, Newman/Postman, `gotestsum`. The hand-rolled fixtures we have (Vitest, Pest, Playwright) all parse correctly; still need real output from the rest to catch dialect-specific quirks.
- [x] **TestNG** `testng-results.xml` (Selenium-via-TestNG, WebdriverIO) — `src/parsers/testng.js`, streaming, excludes `is-config="true"` setup/teardown methods.
- [x] **NUnit3** XML (`.NET` / Selenium-with-NUnit) — `src/parsers/nunit.js`, streaming, nested `<test-suite>` path.
- [x] **.trx** (`dotnet test`'s own MSTest schema) — `src/parsers/trx.js`. `<Results>` comes before `<TestDefinitions>` in a standard .trx file, so results are buffered and joined against definitions at end-of-stream rather than yielded incrementally (still no DOM; just not mid-file streaming for this one format).
- [ ] **Robot Framework** `output.xml` — its own rich schema (keywords, suites, tags). Not yet implemented - lower priority than the others, larger schema for less common usage in this project's context.
- [x] **Cypress / Mocha** Mochawesome JSON — `src/parsers/mochawesome.js`, nested suites, `err.estack`.
- [ ] **pytest** `pytest-json-report` and **Go** `go test -json` (stream) — not yet implemented.
- [x] **CTRF** JSON input — `src/parsers/ctrf.js`.
- [x] **TAP** stream (`node --test`, `tap`, `pytest-tap`) — `src/parsers/tap.js`, streams via `readline`; parses `ok`/`not ok`, `# SKIP`/`# TODO`, and the common `key: value` subset of the YAML diagnostic block (not a full YAML parser).
- [x] `--output ctrf` — parses the discovered reports and prints a CTRF document to stdout without publishing (`toCtrf()` in `src/parsers/ctrf.js`), so Testrix also works as a one-shot converter.
- [x] Format auto-detection by content sniff for ambiguous extensions (`.xml` between JUnit/TestNG/NUnit3, `.json` between Playwright/k6/CTRF/Mochawesome) — `src/parsers/sniff.js`. No `--format` override flag yet (sniffing hasn't needed one).

## E9b — Format coverage: load & performance tools · P1 · L · _model change_

Load tools don't report pass/fail test cases — they report **checks**,
**thresholds/SLAs**, and **metric distributions**. Map check + threshold results
to `passed` / `failed` cases; give metrics a real home.

- [x] Model: each test-case record can now carry `metrics: { name, value, unit }[]` (p95 latency, RPS, error rate, ...) instead of stuffing numbers into `errorMessage`. It's additive and only produced by k6/JMeter so far. **`buildPayload` does not yet forward it to the API** — the dashboard/API doesn't have a column for it; coordinate with E0/E2 before wiring it through.
- [x] **k6:** `src/parsers/k6.js`, reading a `--summary-export` / `handleSummary()` JSON. Each `check` (recursively through groups) → a case; each metric `threshold` → a case; `metrics` carries the underlying values (p90/p95/avg/etc). Does not read the streamed `--out json` event log (a different, much larger format) - only the summary export.
- [x] **JMeter:** `src/parsers/jmeter.js` streams `.jtl` in both **CSV** and **XML** (`<httpSample>`/`<sample>`, incl. nested `<assertionResult><failureMessage>`). Aggregates by sampler `label` (memory is O(unique labels), not O(sample count) - verified with the streaming approach used elsewhere in E1) into one case per label with `metrics` (count, error rate, avg/min/max). Per-sample-level cases were considered and rejected: label count is typically small and bounded, sample count is not.
- [ ] **Gatling:** `simulation.log` (or the newer JSON) — requests → cases, assertions → pass/fail. Not yet implemented.
- [ ] **Locust:** `--csv` / `--json` — request stats → cases, failure ratio → status. Not yet implemented.
- [x] JMeter/k6 HTML dashboards are SPAs with no scrapable rows — not explicitly guarded yet (unlike Playwright's HTML case), but `.html`/`.htm` already routes to the generic `parseHtml`, which will simply find no rows rather than crash.
- [ ] Decide whether the hand-rolled `glob.js` should become `picomatch` if patterns grow.

## E10 — Observability · P2 · S

- [x] `--log-format json` — one JSON object per line (`{level, msg, ts}`), same stdout/stderr routing as text mode.
- [x] `--debug-bundle <path>` — a redacted **JSON** snapshot (resolved config, discovered files, parse summary, timings, the error if the run failed) for bug reports. Not literally a tarball, despite the flag name matching the original ask - simpler, and everything in it is already text.
- [x] Timing breakdown — `publishTestReports` returns `timings: {discoverMs, parseMs, uploadMs}` (also logged at debug level, and included in `--debug-bundle`).
- [ ] TTY-aware progress line for large uploads. Not done - there's only one upload request today (E2 not shipped), so there's no discrete upload progress to show; a parse-progress line (`150,000 / 1,000,000 cases`) would be the more useful version of this until E2 lands.

## E11 — Docs · P2 · M

- [ ] Split the README: it's grown with every wave (Playwright section, full config table, security, programmatic API); still one file. Not done - it's organised with clear headers and cross-links to `docs/`, but hasn't been physically split.
- [x] Copy-paste CI recipes: `docs/ci-recipes.md` — GitHub Actions, GitLab, CircleCI, Jenkins, Bitbucket, generic; publish-on-failure and gate-the-build notes.
- [x] `docs/architecture.md` — the discover→parse→transform→transport pipeline.
- [ ] `docs/adr/` — record the SAX choice, protocol v2, the `xlsx` decision. Not done; `docs/api-contract.md` and this file's own history cover the reasoning informally for now.
- [x] `docs/scaling.md` — the numbers, the caps. (`--resume` itself is still E2, not shipped.)

---

## Sequencing

| Wave                        | Epics                    | Status                                                                                                                                                                                                       |
| --------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Now** (no API dependency) | E0, E1, E4, E5, E7       | **Done.** Audit-clean install, streaming JUnit/Playwright-JSON, green CI matrix, redaction/https/proxy/redirect guards.                                                                                      |
| **Next**                    | E2 (blocked), E3, E6, E9 | **E3 done, E9 mostly done** (8 formats; Robot Framework + real-tool fixtures remain). **E2 blocked** on E0's answers; E2a shipped. E6 mostly done (fuzz, golden test, load test; real-tool fixtures remain). |
| **Then**                    | E8, E9b, E10, E11        | **E8, E10 done** (bar minor items). **E9b mostly done** (k6 + JMeter shipped, streamed; Gatling/Locust remain). E11 docs done; README split/ADRs remain.                                                     |

E9b's JMeter support did need E1 to land first, as expected (`.jtl` files are
multi-GB) - it streams via the same `saxes`/line-reader approach as everything
else. E9b's `metrics` field is additive and doesn't touch the API/dashboard.

Effort key: **S** ≈ ≤1 day · **M** ≈ 2–5 days · **L** ≈ 1–2 weeks.
