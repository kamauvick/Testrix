# Testrix CLI — hardening & scale roadmap

Bring the CLI to production-grade engineering standards, make it upload a test
run of **any size** — from 10 tests to 1,000,000 — in bounded memory and time,
and make it speak the formats the industry actually produces (functional **and**
load/perf tooling).

> **Progress:** E5 done · E6 coverage gate in place · E4 `xml2js`→`saxes` done, lazy-loading + audit/provenance done (`xlsx` swap pending) · E7 secret redaction + https + XXE guard done · E0 contract doc written (answers owed). **E1 done** except Playwright-JSON streaming and the load-fixture RSS test in CI. E2 next.

## Definition of done for "scales regardless of upload size"

- [ ] Parsing and uploading are **O(batch), not O(report)** — peak RSS stays flat as the report grows.
- [ ] A **1 GB** JUnit XML file parses without OOM (streaming, not `readFileSync` + DOM).
- [ ] **1,000,000** test cases upload successfully, resumably, in bounded memory.
- [ ] No single HTTP request body exceeds a few MB (gzipped batches).
- [ ] Wall-clock budget: ≤ ~5 min for 1M cases on a standard 2-CPU CI runner.
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
- [ ] **Playwright JSON streaming** — still buffered (`JSON.parse`). Add `stream-json` for files over a threshold; walk `suites[].specs[].tests[]` keeping one spec-file subtree at a time.
- [ ] Excel/HTML: document the "loads whole file" ceiling in `docs/scaling.md`.
- [ ] CI: a nightly job that parses a generated 1M-case fixture and asserts a peak-RSS budget.

## E2 — Chunked, resumable upload protocol v2 · P0 · L · _needs API_

- [ ] RFC to the `dashboard-api` team: `POST /runs` (create → id) → `POST /runs/:id/cases` in batches → `POST /runs/:id/complete` (summary + start/end time).
- [ ] Batch size default 500; gzip each body; per-batch `Idempotency-Key` + batch index.
- [ ] Bounded concurrency for batch POSTs (default 4–6 in flight) with backpressure from the parse stream.
- [ ] Resumability: persist acked batch indices to `.testrix/state-<runId>.json`; `--resume` re-sends only the gap. Idempotency keys make re-sends safe with or without the state file.
- [ ] Feature-probe (or `--legacy-upload`): fall back to a single POST **with a hard size cap** and a clear over-cap error.
- [ ] **E2a (ship now, no API dep):** gzip the existing single POST, add the size cap + guidance, reuse the retry/backoff in `src/http.js`.
- [ ] Test: 1M-case upload against a mock server; kill mid-upload, `--resume`, no duplicates.

## E3 — Architecture & module boundaries · P1 · M

- [ ] Split into `discover → parse (stream) → transform → transport`, each independently testable; keep the dependency graph acyclic.
- [ ] Public API: keep `loadConfig`; add `createReporter(config)` returning `{ run(), on(event) }` for programmatic / CI-plugin use.
- [ ] Define and document a stable internal `TestCaseRecord` shape; ship `.d.ts`.
- [ ] Parser registry so third-party formats (CTRF, TAP) can self-register.

## E4 — Supply chain & dependencies · P0 · M

- [x] Drop `xml2js` (maintenance-only, prior prototype-pollution CVE) — replaced by `saxes` (E1).
- [ ] `xlsx@0.18.5` is the last npm-registry SheetJS release and carries unpatched advisories (`npm audit` flags it forever). Move Excel to `exceljs` (streaming, maintained) **and/or** `optionalDependencies`.
- [x] Lazy-`require` `cheerio` and `xlsx` — loaded only when an `.html` / `.xls(x)` file is parsed.
- [x] `package-lock.json` committed; `npm ci` in CI.
- [x] `npm publish --provenance` (release workflow).
- [x] `npm audit --audit-level=high` job in CI _(non-blocking until `xlsx` is dealt with)_.
- [ ] `engine-strict`; pin GitHub Action SHAs (currently major tags).

## E5 — CI / release engineering · P0 · M

- [x] `.github/workflows/ci.yml`: lint + format check + `npm test` + coverage + `npm audit`, matrix Node 18.17/20/22 on Linux **and Windows**.
- [x] `release.yml`: on tag → `npm publish --provenance` + GitHub release, with a tag/version guard.
- [x] `CHANGELOG.md` (Keep a Changelog); `1.2.0 → Unreleased` delta captured.
- [x] `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`, issue/PR templates.
- [x] Dependabot config (npm + github-actions).
- [ ] `CODE_OF_CONDUCT.md`; Conventional Commits + commitlint (optional).

## E6 — Testing & quality gates · P1 · M

- [x] Coverage via `c8` with an enforced floor (`test:coverage`: lines 80 / functions 80 / branches 70; currently ~87 / ~91 / ~74).
- [ ] Replace hand-written fixtures with **real** output from Playwright, Vitest, jest-junit, Pest/PHPUnit, pytest, Cypress, TestNG, `dotnet test` (.trx), Robot Framework, k6, JMeter (see E9 / E9b).
- [ ] Fuzz the JUnit stream parser: unclosed tags, huge attributes, entity-expansion / billion-laughs (confirm `saxes` limits hold).
- [ ] Nightly load test: synthetic 100k / 1M generators, assert peak RSS + wall time.
- [ ] Golden-file tests for `buildPayload`; `--dry-run` snapshot per fixture.

## E7 — Security hardening · P1 · M

- [x] `apiKey` scrubbed from every log line (`logger.addSecret`); `redactUrl` strips URL credentials before logging. Regression test in `test/redact.test.js`.
- [x] `serverApiUrl` must be `https` unless localhost or `--allow-insecure-url` / `TESTRIX_ALLOW_INSECURE_URL`. Test in `test/config.test.js`.
- [ ] Don't silently follow cross-origin redirects on the upload — log them.
- [ ] Glob walker: guard against symlink cycles; with `--root` set, refuse report paths that resolve outside it.
- [x] XML: `saxes` does not resolve external entities; JUnit reports declaring DTD entities are rejected outright. Billion-laughs test in `test/junit-stream.test.js`.
- [ ] Proxy support via `undici` `ProxyAgent` honoring `HTTPS_PROXY` / `NO_PROXY`.

## E8 — Config & DX · P2 · M

- [ ] cosmiconfig-style discovery: `testrix.config.{json,cjs,js}`, `.testrixrc`, a `testrix` key in `package.json`, walking up from cwd; keep `config.json` with a deprecation note.
- [ ] Ship a JSON Schema for the config; validate against it with an error that names the offending path.
- [ ] `testrix init` — scaffold config + print the CI snippet for the detected provider.
- [ ] Publish `.d.ts` for the programmatic API.
- [ ] `--print-config` — resolved config with secrets redacted.

## E9 — Format coverage: functional test frameworks · P1 · L

Goal: ingest what the industry actually emits, not just the three formats we
started with. Most tools below can emit JUnit XML, but every generator's dialect
differs — build a **JUnit conformance suite** and add native parsers only where
JUnit loses information.

- [ ] **JUnit dialect conformance:** real fixtures + tests for jest-junit, pytest (`--junitxml`), Surefire/Failsafe (Java), rspec_junit_formatter, Cypress (`mocha-junit-reporter`), WebdriverIO, Karma, Newman/Postman, `gotestsum`. Handle each one's `classname`/`name`/nesting/`file` quirks.
- [ ] **TestNG** `testng-results.xml` — its own schema (Selenium-via-TestNG, WebdriverIO). Native parser.
- [ ] **.NET:** NUnit3 XML and `.trx` (`dotnet test`) — native parsers.
- [ ] **Robot Framework** `output.xml` — its own rich schema (keywords, suites, tags). Native parser.
- [ ] **Cypress / Mocha** Mochawesome JSON — native parser (richer than its JUnit: retries, screenshots, `context`).
- [ ] **pytest** `pytest-json-report` and **Go** `go test -json` (stream) — native parsers.
- [ ] **CTRF** JSON input (detect the schema) — the emerging cross-runner standard; many tools now ship a CTRF reporter.
- [ ] **TAP** stream (`node --test`, `tap`, `pytest-tap`) — streams naturally, fits E1.
- [ ] `--output ctrf` so Testrix can also act as a converter.
- [ ] Format auto-detection by content sniff, not just extension; `--format <name>` to force.

## E9b — Format coverage: load & performance tools · P1 · L · _model change_

Load tools don't report pass/fail test cases — they report **checks**,
**thresholds/SLAs**, and **metric distributions**. Map check + threshold results
to `passed` / `failed` cases; give metrics a real home.

- [ ] Model: add a `metrics` object to the test-case / run record (`{ name, value, unit }[]` — p95 latency, RPS, error rate) instead of stuffing them into `errorMessage`. Dashboard/API change — coordinate with E0/E2.
- [ ] **k6:** `handleSummary` / `--summary-export` JSON and streamed `--out json`. Each threshold → a case (met/not met); each `check` → a case; attach `http_req_duration` p90/p95/p99, iterations, RPS as `metrics`.
- [ ] **JMeter:** `.jtl` in **XML** (`<httpSample>`/`<sample>`) and **CSV** (header-driven). Per-sampler aggregate → a case; optionally per-sample → cases. `.jtl` files are routinely multi-GB — **must** stream (hard dependency on E1).
- [ ] **Gatling:** `simulation.log` (or the newer JSON) — requests → cases, assertions → pass/fail.
- [ ] **Locust:** `--csv` / `--json` — request stats → cases, failure ratio → status.
- [ ] JMeter/k6 HTML dashboards are SPAs with no scrapable rows — detect and point users at the raw `.jtl` / JSON (same pattern as the Playwright HTML guard).
- [ ] Decide whether the hand-rolled `glob.js` should become `picomatch` if patterns grow.

## E10 — Observability · P2 · S

- [ ] `--log-format json` — one JSON object per line to stderr for CI log processors.
- [ ] `--debug-bundle <path>` — redacted tarball (resolved config, discovered files, parse counts, HTTP timeline) for bug reports.
- [ ] Timing breakdown in the summary (discover / parse / upload ms).
- [ ] TTY-aware progress line for large uploads (`1,240,000 / 1,500,000 · batch 2480/3000`); off under `--output json` / non-TTY.

## E11 — Docs · P2 · M

- [ ] Split the README: keep quick-start; move the config table, Playwright detail and CI recipes into `docs/`.
- [ ] Copy-paste CI recipes: GitHub Actions, GitLab, CircleCI, Jenkins, Bitbucket.
- [ ] `docs/architecture.md` — the discover→parse→transform→transport pipeline and the upload protocol.
- [ ] `docs/adr/` — record the SAX choice, protocol v2, the `xlsx` decision.
- [ ] `docs/scaling.md` — the numbers, the caps, `--resume`.

---

## Sequencing

| Wave                        | Epics                           | Gate                                                                                   |
| --------------------------- | ------------------------------- | -------------------------------------------------------------------------------------- |
| **Now** (no API dependency) | E0, E1, E4, E5, E7              | audit-clean install; streaming parser; green CI matrix                                 |
| **Next**                    | E2 (RFC + ship E2a), E3, E6, E9 | resumable 1M-case upload; coverage floor; JUnit dialect suite + TestNG/.trx/Robot/CTRF |
| **Then**                    | E8, E9b, E10, E11               | config from `package.json`; k6 + JMeter (streamed); docs split                         |

E9b (k6, JMeter, Gatling) rides on E1 — JMeter `.jtl` files are multi-GB, so
streaming has to land first — and on the E9b model change landing in the API
alongside E2.

Effort key: **S** ≈ ≤1 day · **M** ≈ 2–5 days · **L** ≈ 1–2 weeks.
