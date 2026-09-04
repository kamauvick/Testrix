# Testrix CLI

**Testrix CLI** is a command-line tool designed to parse test reports from the tools you actually use - JUnit XML, Playwright, TestNG, NUnit3, Cypress/Mochawesome, CTRF, TAP, k6, JMeter, HTML, Excel - and publish the results to a specified server API. This allows for centralized tracking, analytics, and dashboards for your CI/CD pipelines and local environments.

---

## 📦 Features

- ✅ **Functional test frameworks:** JUnit XML (Vitest, Pest/PHPUnit, Surefire, ...), Playwright (`junit` + `json`), TestNG, NUnit3, Cypress/Mocha (Mochawesome), CTRF, TAP (`node --test`, `tap`), plus `.html` and `.xls/.xlsx`. `.xml`/`.json` are content-sniffed, so it doesn't matter which tool produced them.
- 📈 **Load/perf tools:** k6 (checks + threshold SLAs) and JMeter `.jtl` (CSV or XML, streamed and aggregated by sampler label even at multi-GB size).
- 🎭 First-class [Playwright](#playwright) support: projects (browsers), retries, flaky tests, attachments, and crash detection
- 📁 Extracts test case results including status, duration, and error details
- 📊 Aggregates summary statistics (total, passed, failed, skipped, flaky)
- 🌐 **Publishes results to a configurable server API endpoint**
- 🧪 Designed for integration with CI tools like GitLab CI, GitHub Actions, Jenkins, etc.
- ⚙️ **Near-zero config** — only `projectId` + `apiKey` are needed; reports, branch, commit, environment and user are auto-detected from disk / CI / git

---

## 🚀 Installation

To install Testrix CLI, run the following command:

```bash
npm install -g testrix-cli
```

## 🛠️ Usage

### Quick start (no config file)

Set your credentials and run — Testrix finds the reports and fills in the rest:

```bash
export TESTRIX_PROJECT_ID=your-project-id
export TESTRIX_API_KEY=your-api-key
testrix
```

Or pass them as flags:

```bash
testrix --project your-project-id --api-key your-api-key
```

That's the whole setup in CI. Testrix will:

- **discover reports** by scanning `test-results/`, `test-reports/`, `reports/`, `junit/`, then `.`;
- **read `branch`, `commit`, `name` and `userId`** from the CI provider (GitHub Actions, GitLab CI, CircleCI, Jenkins, Bitbucket) or from local `git`;
- **fall back** to the OS username and `git config user.email` when not in CI.

### Config file (optional)

Only for values you want to pin. `src/config.json.template` is the minimal form:

```json
{
  "projectId": "YOUR_PROJECT_ID",
  "apiKey": "YOUR_API_KEY"
}
```

All supported keys (every one is optional except `projectId` / `apiKey`, and each
has an env var and, for most, a CLI flag):

| Key                      | Env var                      | Flag                            | Default                                 |
| ------------------------ | ---------------------------- | ------------------------------- | --------------------------------------- |
| `projectId`              | `TESTRIX_PROJECT_ID`         | `--project`                     | **required**                            |
| `apiKey`                 | `TESTRIX_API_KEY`            | `--api-key`                     | **required**                            |
| `serverApiUrl`           | `TESTRIX_SERVER_API_URL`     | `--url`                         | prod dashboard API                      |
| `allowInsecureUrl`       | `TESTRIX_ALLOW_INSECURE_URL` | `--allow-insecure-url`          | `false` (https required off-localhost)  |
| `dashboardUrl`           | `TESTRIX_DASHBOARD_URL`      | `--dashboard-url`               | derived from `serverApiUrl`             |
| `reportsDir`             | `TESTRIX_REPORTS_DIR`        | `--reports`                     | auto-discovered                         |
| `reportFiles`            | —                            | `--reports` (repeatable, globs) | —                                       |
| `userId`                 | `TESTRIX_USER_ID`            | `--user`                        | CI actor → git email → OS user          |
| `environment`            | `TESTRIX_ENVIRONMENT`        | `--env`                         | CI environment, else none               |
| `branch`                 | `TESTRIX_BRANCH`             | `--branch`                      | CI, else `git`                          |
| `commit`                 | `TESTRIX_COMMIT`             | `--commit`                      | CI, else `git`                          |
| `name`                   | `TESTRIX_RUN_NAME`           | `--name`                        | CI workflow/job, else suite names       |
| —                        | `TESTRIX_UPLOAD_TIMEOUT_MS`  | `--timeout`                     | `30000` (per attempt)                   |
| —                        | `TESTRIX_UPLOAD_RETRIES`     | `--retries`                     | `4` (retries transient 5xx/429/network) |
| `maxCases`               | `TESTRIX_MAX_CASES`          | `--max-cases`                   | `200000` (`0` = unlimited)              |
| —                        | `TESTRIX_MAX_FIELD_BYTES`    | —                               | `16384` per error/stdout/stderr field   |
| `includeSuitesInPayload` | —                            | —                               | `false`                                 |
| `projectDescription`     | —                            | —                               | —                                       |

`startTime` / `endTime` default to the run window read from the reports
themselves (JUnit `timestamp` + `time`, Playwright `stats`), falling back to
"now"; set them in the config file to override.

**Large reports.** JUnit XML is parsed as a stream — a multi-hundred-MB report
never sits in memory as a DOM. Playwright JSON reports over 20 MB
(`TESTRIX_JSON_STREAM_THRESHOLD_BYTES`) are streamed the same way, one spec
file at a time. Long error stacks and captured stdout/stderr are clamped
(16 KB each), and the run is capped at `maxCases` test cases with a warning
when it truncates; raise or disable it with `--max-cases`.

Precedence: **CLI flag → config file → `TESTRIX_*` env → CI env → git → built-in default.**

### Running

```bash
testrix                                   # zero-config, auto-discovers everything
testrix ./ci/testrix.json                 # explicit config file
testrix --reports "out/**/junit-*.xml"    # glob; repeat --reports for several
testrix --dry-run                         # parse & summarise, don't publish
testrix --output json                     # machine-readable result on stdout
testrix --fail-on-failed                  # exit 3 if any test failed
```

On success Testrix prints the run's dashboard URL (`View: …`). `--output json`
emits `{ok, testRunId, url, published, summary, dryRun}` on stdout (all logs go
to stderr). Uploads retry transient failures with backoff and time out per
attempt.

**Exit codes:** `0` ok · `1` error (config / parse / upload) · `2` `--fail-on-empty` · `3` `--fail-on-failed`. A successful publish is `0` even when tests failed unless you opt into a stricter gate.

---

## Project Structure

```
cli.js                  # executable entry point (flags, arg parsing, exit codes)
src/
  ├── index.js           # public programmatic API
  ├── config.js          # layered config: file → env → CI → git → defaults
  ├── ci.js              # CI provider + git metadata detection
  ├── glob.js            # small glob matcher for --reports patterns
  ├── http.js            # upload with timeout, retry/backoff, run-URL derivation
  ├── redact.js          # secret / URL-credential redaction
  ├── limits.js          # field-size + max-cases bounds
  ├── logger.js          # leveled logger (TESTRIX_LOG_LEVEL), secret scrubbing
  ├── publisher.js       # discover → stream-parse → build payload → submit
  ├── config.json.template
  └── parsers/
      ├── index.js           # parserForFile() / streamParserForFile() dispatch
      ├── junit.js           # streaming JUnit XML (Vitest, Pest/PHPUnit, Playwright)
      ├── playwright-json.js # Playwright `json` reporter
      ├── html.js            # HTML reporter output
      ├── excel.js           # .xls / .xlsx
      └── shared.js          # summary + status helpers, ANSI / control stripping
test/                   # node:test unit tests + fixtures
```

**Requires Node.js >= 18.17** (uses the built-in `fetch` and test runner).

**Note**: Testrix CLI does not manage a local database. It sends data to your configured server API, which is responsible for storage.

### Programmatic use

```js
const { loadConfig, publishTestReports } = require('testrix-cli');

// configPath and overrides are both optional; env / CI / git fill the rest.
const config = loadConfig('./config.json', { environment: 'staging' });
const { summary, published } = await publishTestReports(config, { dryRun: false });
```

### Environment variables

See the [config table](#config-file-optional) for the full list. Two that have no
config-file equivalent:

| Variable            | Purpose                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| `TESTRIX_LOG_LEVEL` | `silent` \| `error` \| `warn` \| `info` (default) \| `debug`                     |
| `CI`                | Any value marks the run as CI (used as a hint when no specific provider matches) |

### Security

- The API key is sent only as the `x-api-key` header to `serverApiUrl`; it is
  redacted (`***`) from every log line and error message, and URL credentials are
  stripped before logging.
- `serverApiUrl` must be `https` unless it targets localhost or you pass
  `--allow-insecure-url` / set `TESTRIX_ALLOW_INSECURE_URL`.
- A same-origin redirect (307/308) is followed; a cross-origin redirect, or one
  that would drop the request body (301/302/303), is refused rather than
  silently followed.
- Uploads honour `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`.
- `.xls`/`.xlsx` support needs the optional `xlsx` package
  (`npm install xlsx`) - kept optional because it carries advisories with no
  upstream fix; the rest of Testrix installs `npm audit`-clean.
- Report vulnerabilities per [SECURITY.md](SECURITY.md).

### Development

```bash
npm ci
npm test              # node --test
npm run test:coverage # c8, with a coverage floor
npm run lint          # eslint
npm run format:check  # prettier
```

Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md). Roadmap: [TODO.md](TODO.md).

---

## Playwright

Testrix understands the output of Playwright's built-in reporters. Enable the
`junit` and/or `json` reporter (they can run alongside `html`):

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [
    ['html'],
    ['junit', { outputFile: 'test-results/results.xml' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
});
```

Writing them under `test-results/` (as above) means Testrix finds them with no
further config — just `testrix`. Otherwise point `--reports` / `reportsDir` /
`reportFiles` at the file. `.xml` and `.json` are parsed the same way and produce
the same fields:

| Playwright concept                           | How Testrix maps it                                                                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project (browser) — `chromium`, `firefox`, … | JUnit `<testsuite hostname>` / JSON `projectName`. Prefixed onto the suite as `[chromium] …` **only when a run spans more than one project**.                    |
| Status                                       | `expected`→passed, `unexpected` / `timedOut` / `interrupted`→failed, `flaky`→flaky, `skipped`→skipped.                                                           |
| Retries                                      | `retryCount` on the test case.                                                                                                                                   |
| Flaky (failed then passed)                   | status `flaky`; also counted in the run summary. Requires the JUnit reporter's `includeRetries: true`, or use the `json` reporter (always accurate).             |
| Screenshots / videos / traces                | Pulled from `[[ATTACHMENT\|path]]` markers (JUnit) or `attachments[]` (JSON) into `screenshot` / `video` / `trace`. Paths are relative to the report file.       |
| ANSI colour codes in errors                  | Stripped (Playwright's `stripANSIControlSequences` defaults to off).                                                                                             |
| Durations                                    | Normalised to **milliseconds** (JUnit `time` is seconds and is converted).                                                                                       |
| Global setup / web-server / worker crash     | Reports with `errors="N"` but no test cases (or a top-level `errors[]` in JSON) become a synthetic **failed** case, so a broken run is never published as green. |

Not directly ingestible:

- **HTML report** (`playwright-report/`) — a single-page app with no scrapable
  rows. Testrix fails with a message telling you to also enable `junit` / `json`.
- **Blob report** (`blob-report/*.zip`) — merge it first:
  `npx playwright merge-reports --reporter junit ./blob-report > results.xml`.
- **Sharded runs** — publish every shard's `.xml` / `.json` (list them all in
  `reportFiles`, or drop them in `reportsDir`); Testrix merges them.

## Vitest/Pest JUnit and explicit report files

- If you generate a vitest or Pest (PHPUnit) JUnit file without an extension (e.g., `frontend-junit` or `pest-junit` at the repo root), add it via `reportFiles`:

```json
{
  "reportsDir": "./test-reports",
  "reportFiles": ["./frontend-junit"]
}
```

- The CLI will also attempt to parse extensionless files as JUnit XML automatically when discovered in specified directories.
- The JUnit parser supports nested `<testsuite>` structures and PHPUnit/Pest variations for failures and errors.
