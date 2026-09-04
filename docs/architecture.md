# Architecture

Testrix is a four-stage pipeline. Each stage is a separate module and can be
used independently of the CLI (see [Programmatic use](../README.md#programmatic-use)).

```
discover            parse (stream)          transform            transport
───────────         ─────────────────       ─────────            ─────────
src/publisher.js    src/parsers/*.js        src/publisher.js     src/http.js
discoverReportFiles streamParserForFile()   buildPayload()       submitReport()
                     -> AsyncGenerator<TestCaseRecord>
```

## discover

`discoverReportFiles(config)` (`src/publisher.js`) turns `config.reportsDir` /
`config.reportFiles` into a flat list of file paths:

- an explicit `reportsDir` is scanned one level deep (`enumerateDirectory`);
- with no `reportsDir` and no `reportFiles`, it auto-probes
  `test-results/`, `test-reports/`, `reports/`, `junit/`, then `.`
  (`autoDiscoverReportsDir`);
- `reportFiles` entries can be a file, a directory, or a glob
  (`src/glob.js`, resolved recursively with a symlink-cycle guard).

## parse (stream)

Every format has a pair of entry points, both returning / yielding the same
[`TestCaseRecord`](../src/index.d.ts) shape:

- `parseX(filePath)` - buffered convenience wrapper, returns
  `{ summary, testCases, startTime, endTime }`. Used directly by tests and by
  anyone who just wants the whole result.
- `streamX(filePath, acc)` - an `async function*` yielding one
  `TestCaseRecord` at a time; `acc` is filled with `startTime`/`endTime` once
  the generator finishes. `parseX` is implemented as "drain `streamX` into an
  array" for every format.

`src/parsers/index.js` dispatches a file to the right pair:

- fixed extensions (`.jtl` → JMeter, `.tap` → TAP, `.html`/`.htm`,
  `.xls`/`.xlsx`) map directly;
- `.xml` (and extensionless files) are content-sniffed between JUnit / TestNG /
  NUnit3 by root element (`sniffXmlFormat`, `src/parsers/sniff.js`);
- `.json` is sniffed between Playwright / k6 / CTRF / Mochawesome by top-level
  keys (`sniffJsonFormat`).

`parseReports(files, { maxCases })` (`src/publisher.js`) is the driver: it
pulls records one at a time from each file's streamer, counts them into a
merged `summary`, and stops once `maxCases` is reached (`truncated: true`).
Because it consumes an async generator rather than an array, a single
multi-hundred-MB JUnit or Playwright-JSON report never has to sit fully in
memory as a DOM/object tree - see [scaling.md](./scaling.md).

Two parsers do real streaming beyond "don't build a DOM": Playwright JSON
switches to `stream-json` above a size threshold (assembling one spec file at
a time), and JMeter's `.jtl` is aggregated by sampler label as it streams, so
memory tracks unique labels rather than sample count.

## transform

`buildPayload(config, { testCases, suites, startTime, endTime })`
(`src/publisher.js`) turns the internal records into the wire shape the
dashboard API expects: title/status/duration/error fields, `line` /
`retryCount` / `screenshot` / `video` / `trace` when present, and a
`[project]` prefix folded into `suite` when a run spans more than one
Playwright project. See [api-contract.md](./api-contract.md) for the exact
shape and its open questions.

## transport

`submitReport(config, payload, options)` (`src/http.js`) POSTs the payload
with a timeout, bounded retry + backoff on transient failures, an
`Idempotency-Key`, proxy support, and a same-origin-only redirect policy. A
hard `maxUploadBytes` cap rejects an oversized body locally before it's sent.

## Tying it together

`publishTestReports(config, options)` (`src/publisher.js`) runs all four
stages in order and is what the CLI (`cli.js`) calls. It also accepts an
`onEvent(name, data)` callback, which `createReporter(config)`
(`src/reporter.js`) wraps in an `EventEmitter` for programmatic callers that
want progress (`discover` / `parse` / `upload:start` / `upload:done` / `done`)
rather than just the final promise.

## Adding a format

See [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-report-format).
