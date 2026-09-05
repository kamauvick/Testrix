# Contributing to Testrix CLI

## Setup

```bash
npm ci
npm test            # node --test
npm run lint        # eslint
npm run format:check # prettier
npm run types:check # tsc against src/index.d.ts
npm run test:coverage
```

If you change the shape of anything exported from `src/index.js` (new export,
changed return shape, new option), update `src/index.d.ts` to match and rerun
`npm run types:check`.

Requires Node.js >= 18.18.

## Working on the code

- **Match the surrounding style.** CommonJS, small focused modules under `src/`,
  a parser per format under `src/parsers/`. `npm run format` before committing.
- **Every change gets a test.** `test/*.test.js`, `node:test` + `node:assert`.
  Parser changes need a fixture under `test/fixtures/` — prefer real output from
  the tool over hand-written XML.
- **Keep the layers separate.** `discover` → `parse` → `transform` (`buildPayload`)
  → `transport` (`http.js`). Parsers return records; they don't know about HTTP.
- **User-facing changes** update `README.md` (or `docs/`) and the `[Unreleased]`
  section of `CHANGELOG.md`.
- **Roadmap.** Larger work is tracked in `TODO.md`; reference the epic (e.g.
  `E1 — streaming ingestion`) in your PR.

## Adding a report format

1. `src/parsers/<tool>.js` exporting `async function parse<Tool>(filePath)` that
   returns `{ summary, testCases, startTime, endTime }`.
2. Register it in `src/parsers/index.js` (`parserForFile`) and, if it has a new
   extension, in `src/publisher.js` (`REPORT_EXTENSIONS`, `enumerateDirectory`).
3. Fixture(s) + tests. Include a malformed sample if the parser does its own
   validation.
4. A line in the README format list and `CHANGELOG.md`.

## Pull requests

- Branch from `main`; keep PRs focused.
- CI must be green (lint, format, tests on Node 18/20/22 × Linux/Windows, coverage).
- Do not bump the version or edit `CHANGELOG.md` release headers — releases are cut
  from tags by the maintainers.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).
