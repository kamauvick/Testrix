# Dashboard API contract

> Status: **needs verification against production.** This records what the CLI
> currently sends and an open discrepancy with the `wp-qa-testing-dashboard-api`
> source. Resolve before building the streaming / batched upload (TODO.md E1–E2).

## Endpoint

`POST {serverApiUrl}` — default
`https://testing-dashboard-api.myworkpay.com/api/submit-test-reports`.

Headers sent by the CLI (`src/http.js`):

| Header            | Value                                       |
| ----------------- | ------------------------------------------- |
| `Content-Type`    | `application/json`                          |
| `x-api-key`       | the configured API key                      |
| `User-Agent`      | `testrix-cli/<version> node/<v> <platform>` |
| `Idempotency-Key` | a random UUID per run                       |

## Request body the CLI sends (`buildPayload`)

```jsonc
{
  "testRun": {
    "name": "…", // suite names joined, else config.name, else "Test Run"
    "userId": "…",
    "projectId": "…",
    "environment": null,
    "branch": null,
    "commit": null,
    "startTime": "ISO-8601", // derived from the reports
    "endTime": "ISO-8601",
  },
  "testCases": [
    {
      "title": "…",
      "status": "passed|failed|skipped|flaky",
      "duration": 0, // integer milliseconds
      "errorMessage": "",
      "errorStack": "",
      "file": "",
      "suite": "",
      "line": 12, // omitted when absent
      "retryCount": 1, // omitted when 0
      "screenshot": "…", // omitted when absent
      "video": "…",
      "trace": "…",
    },
  ],
}
```

`includeSuitesInPayload: true` adds `testRun.suites: string[]`.

## Discrepancy to resolve (E0)

The `wp-qa-testing-dashboard-api` repo's `router.post('/api/submit-test-reports')`
handler reads a **flat** shape — `report.userId`, `report.projectName`,
`report.status`, `report.totalTests`, `report.passedTests`, …, and
`report.testCases[].name` (not `.title`) — and maps only
`{name, status, duration, errorMessage, errorStack, file, suite}` per case.

The `TestCase` model, however, already has columns for `flaky` status,
`retryCount`, `screenshot`, `video`, `trace`, and `line` — so the richer payload
is anticipated somewhere.

**Open questions for the API owners:**

1. Which shape does the deployed prod endpoint accept today — nested `{testRun, testCases}` or the flat legacy one?
2. Success response body: is the run id `testRunId`, `id`, or `runId`? (The CLI reads all three.)
3. Status codes for: bad/missing API key, validation failure, rate limiting.
4. Maximum accepted request body size.
5. Does it decompress `Content-Encoding: gzip` request bodies? (`express.json()` does by default — confirm it's enabled.)
6. Is there any existing batching / chunked-ingest endpoint, or is a single POST the only option today?

## Target: chunked protocol v2 (TODO.md E2 — proposed)

```
POST /runs                       -> { runId }
POST /runs/:runId/cases          -> 202   (repeat; gzipped batches of ~500; Idempotency-Key + batch index)
POST /runs/:runId/complete       -> { runId, url }   (summary, startTime, endTime)
```

Until v2 exists, ship E2a: gzip the single POST, enforce a client-side body-size
cap, and fall back with a clear over-cap error.
