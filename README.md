# Testrix CLI

**Testrix CLI** is a command-line tool designed to parse test reports (JUnit, XML, HTML, Excel) and publish the results to a specified server API. This allows for centralized tracking, analytics, and dashboards for your CI/CD pipelines and local environments.

---

## 📦 Features

- ✅ Parses `JUnit`, `.xml`, `.html`, and `.xls/.xlsx` test reports
- 📁 Extracts test case results including status, duration, and error details
- 📊 Aggregates summary statistics (total, passed, failed, skipped)
- 🌐 **Publishes results to a configurable server API endpoint**
- 🧪 Designed for integration with CI tools like GitLab CI, GitHub Actions, Jenkins, etc.

---

## 🚀 Installation

To install Testrix CLI, run the following command:

```bash
npm install -g testrix-cli
```

## 🛠️ Usage

1.  **Create a configuration file**: Create a `config.json` file in your project root, or a specified path. You can use the `src/config.json.template` as a starting point.

    ```json
    {
      "serverApiUrl": "Optional: Override default prod URL or set TESTRIX_SERVER_API_URL",
      "userId": "YOUR_USER_ID",
      "projectId": "YOUR_PROJECT_ID",
      "apiKey": "YOUR_API_KEY",
      "projectDescription": "Optional: A description for your project.",
      "reportsDir": "./test-reports",
      "reportFiles": [
        "./frontend-junit"
      ],
      "includeSuitesInPayload": true,
      "name": "Optional: Test Run Name",
      "environment": "Optional: Environment (e.g., development, staging, production)",
      "branch": "Optional: Git Branch Name",
      "commit": "Optional: Git Commit Hash"
    }
    ```

    *   `serverApiUrl`: The URL of your server's API endpoint. Defaults to prod `https://testing-dashboard-api.myworkpay.com/api/submit-test-reports` if omitted; can be overridden by `TESTRIX_SERVER_API_URL` env or config.
    *   `userId`: A unique identifier for the user initiating the test run.
    *   `projectId` and `apiKey`: Required by the backend for authentication/authorization.
    *   `reportsDir`: Directory scanned for `.xml`, `.html`, `.xls/.xlsx`.
    *   `reportFiles` (optional): Explicit files or directories to include in addition to `reportsDir`. Supports extensionless JUnit files (e.g., `./frontend-junit` from vitest).
    *   `includeSuitesInPayload` (optional): If true, `testRun.suites` will include unique suite names extracted from JUnit files.
    *   `projectDescription`: Optional metadata. Project name can be inferred server-side from `projectId`.

2.  **Run Testrix CLI**: Execute the `testrix` command, optionally providing the path to your config file.

    ```bash
    testrix [path/to/your/config.json]
    ```

    If no path is provided, `testrix` will look for `config.json` in the current working directory.

---

## Project Structure

```
cli.js                  # executable entry point (arg parsing, exit codes)
src/
  ├── index.js           # public programmatic API
  ├── config.js          # load + validate config (file, env, defaults)
  ├── logger.js          # leveled logger (TESTRIX_LOG_LEVEL)
  ├── publisher.js       # discover → parse → build payload → submit
  ├── config.json.template
  └── parsers/
      ├── index.js       # parserForFile() dispatch
      ├── junit.js       # JUnit XML (Vitest, Pest/PHPUnit, nested suites)
      ├── html.js        # HTML reporter output
      ├── excel.js       # .xls / .xlsx
      └── shared.js      # summary + status helpers
test/                   # node:test unit tests + fixtures
```

**Requires Node.js >= 18.17** (uses the built-in `fetch` and test runner).

**Note**: Testrix CLI does not manage a local database. It sends data to your configured server API, which is responsible for storage.

### Programmatic use

```js
const { loadConfig, publishTestReports } = require('testrix-cli');

const config = loadConfig('./config.json');
const { summary, published } = await publishTestReports(config);
```

### Environment variables

| Variable | Purpose |
| --- | --- |
| `TESTRIX_SERVER_API_URL` | Override `serverApiUrl` |
| `TESTRIX_PROJECT_ID` | Provide `projectId` |
| `TESTRIX_API_KEY` | Provide `apiKey` |
| `TESTRIX_LOG_LEVEL` | `silent` \| `error` \| `warn` \| `info` (default) \| `debug` |

### Development

```bash
npm install
npm test      # node --test
npm run lint  # eslint
```

---

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
