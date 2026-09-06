# Scaling & limits

What actually happens as a report grows, the caps that keep memory bounded,
and how to raise or disable them.

## Measured

From `scripts/load-test.js` (also run nightly - see
[`.github/workflows/load-test.yml`](../.github/workflows/load-test.yml)):

| Report                     | Size   | Records   | Time  | Peak RSS delta |
| -------------------------- | ------ | --------- | ----- | -------------- |
| JUnit                      | 132 MB | 1,000,000 | 3.8 s | ≈0 MB          |
| Playwright JSON (streamed) | 41 MB  | 200,000   | 20 s  | ~12 MB         |

JUnit parsing is streaming end to end (`saxes`, no DOM), so peak memory is
independent of file size. Playwright JSON switches to `stream-json` above
`TESTRIX_JSON_STREAM_THRESHOLD_BYTES` (default 20 MB) and assembles one spec
file at a time - memory tracks the largest single spec file, not the whole
run.

## The caps, and how to change them

| Cap                                                            | Default | Flag / env                                            | What happens past it                                                                                   |
| -------------------------------------------------------------- | ------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Per-field size (`errorMessage`/`errorStack`/`stdout`/`stderr`) | 16 KB   | `TESTRIX_MAX_FIELD_BYTES`                             | Truncated with a `…[truncated]` marker                                                                 |
| Total test cases read                                          | 200,000 | `--max-cases` / `TESTRIX_MAX_CASES` (`0` = unlimited) | Reading stops; a warning is logged; `truncated: true` on the result                                    |
| Upload body size                                               | 20 MB   | `--max-upload-bytes` / `TESTRIX_MAX_UPLOAD_BYTES`     | The upload is refused **locally**, before sending, with a message pointing at `--max-cases` / `--gzip` |
| Playwright JSON streaming threshold                            | 20 MB   | `TESTRIX_JSON_STREAM_THRESHOLD_BYTES`                 | Below it: plain `JSON.parse` (simpler, just as correct). Above it: `stream-json`.                      |

Field and case caps exist because a single pathological input (a Playwright
test that dumps megabytes of console output, or a CI run with a runaway test
count) would otherwise defeat every other streaming guarantee by holding it
all in the `testCases` array that `parseReports` builds for the (currently
single-request) upload - see below.

## What isn't streaming yet

- **The upload itself.** `parseReports` still accumulates every yielded record
  into one array, because the API takes a single JSON POST
  ([TODO.md](../TODO.md) E2 - a batched/resumable protocol - is blocked on
  API-side work; E2a shipped the gzip + size-cap half that doesn't need it).
  `--max-cases` is what actually bounds this today.
- **Excel (`.xls`/`.xlsx`) and HTML.** SheetJS and cheerio both load the whole
  file. These formats are not expected to reach the sizes JUnit/JMeter/
  Playwright-JSON do; if that changes, they'd need the same streaming
  treatment.
- **JMeter `.jtl` is streamed but aggregated**, not passed through
  per-sample - by design (see [architecture.md](./architecture.md)), since a
  `.jtl` file's row count (not its label count) is what reaches the
  multi-gigabyte range.

## Raising a cap safely

If you have a legitimately huge, healthy suite (say, 500k real test cases):

```bash
testrix --max-cases 500000 --max-upload-bytes 52428800   # 50 MB
```

Consider whether `--gzip` is worth enabling first (only if your server
confirms it inflates `Content-Encoding: gzip` - see
[api-contract.md](./api-contract.md)); it usually buys back an order of
magnitude of headroom under the upload-size cap.
