'use strict';

const { EventEmitter } = require('node:events');

const { publishTestReports } = require('./publisher');

/**
 * A programmatic, event-driven wrapper around {@link publishTestReports} for
 * CI plugins / dashboards embedding Testrix rather than shelling out to the
 * CLI. `config` is a resolved config (see `loadConfig`/`resolveConfig`).
 *
 * ```js
 * const { loadConfig, createReporter } = require('testrix-cli');
 * const reporter = createReporter(loadConfig());
 * reporter.on('parse', ({ summary }) => console.log(`parsed ${summary.total}`));
 * reporter.on('upload:done', ({ url }) => console.log(`published: ${url}`));
 * const result = await reporter.run({ dryRun: false });
 * ```
 *
 * Events (all optional to listen for): `discover` `{ files }`,
 * `parse` `{ summary, truncated }`, `upload:start` `{ count }`,
 * `upload:done` `{ testRunId, url }`, `done` `{ summary, dryRun: true }`
 * (dry-run only, in place of the upload events).
 * @param {import('./config').TestrixConfig} config
 * @returns {{ on: (event: string, handler: (data: object) => void) => object, run: (options?: object) => Promise<object> }}
 */
function createReporter(config) {
  const emitter = new EventEmitter();
  const reporter = {
    on(event, handler) {
      emitter.on(event, handler);
      return reporter;
    },
    run(options = {}) {
      return publishTestReports(config, {
        ...options,
        onEvent: (name, data) => emitter.emit(name, data),
      });
    },
  };
  return reporter;
}

module.exports = { createReporter };
