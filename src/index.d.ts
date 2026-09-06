// Type definitions for testrix-cli's programmatic API.
// The CLI itself needs no types; these are for `require('testrix-cli')` /
// `import ... from 'testrix-cli'` consumers (CI plugins, dashboards).

export interface TestrixConfig {
  serverApiUrl: string;
  dashboardUrl?: string;
  allowInsecureUrl?: boolean;
  userId: string;
  projectId: string;
  apiKey: string;
  reportsDir?: string;
  reportFiles?: string[];
  includeSuitesInPayload?: boolean;
  name?: string;
  environment?: string | null;
  branch?: string | null;
  commit?: string | null;
  startTime?: string;
  endTime?: string;
  maxCases?: number;
  projectDescription?: string;
}

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'flaky';

/** A single test metric (load-tool data: p95 latency, RPS, error rate, ...). */
export interface TestMetric {
  name: string;
  value: number;
  unit: string;
}

/** The common shape every parser (JUnit, Playwright, TestNG, k6, ...) produces. */
export interface TestCaseRecord {
  title: string;
  status: TestStatus;
  /** Milliseconds. */
  duration: number;
  errorMessage: string;
  errorStack: string;
  file: string | null;
  suite: string | null;
  project: string | null;
  line: number | null;
  retries: number;
  flaky: boolean;
  attachments: Array<{ name: string; path: string | null; contentType?: string }>;
  stdout: string;
  stderr: string;
  /** Present on load-tool records (k6, JMeter); absent elsewhere. */
  metrics?: TestMetric[];
}

export interface Summary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  /** Milliseconds. */
  duration: number;
}

export interface ParseResult {
  summary: Summary;
  testCases: TestCaseRecord[];
  startTime: string | null;
  endTime: string | null;
}

export interface ParseReportsResult extends ParseResult {
  suites: string[];
  truncated: boolean;
}

export interface Payload {
  testRun: {
    name: string;
    userId: string;
    projectId: string;
    environment: string | null;
    branch: string | null;
    commit: string | null;
    startTime: string;
    endTime: string;
    suites?: string[];
  };
  testCases: Array<
    Pick<TestCaseRecord, 'title' | 'status' | 'duration' | 'errorMessage' | 'errorStack'> & {
      file: string;
      suite: string;
      line?: number;
      retryCount?: number;
      screenshot?: string;
      video?: string;
      trace?: string;
    }
  >;
}

export interface PublishOptions {
  dryRun?: boolean;
  retries?: number;
  timeoutMs?: number;
  gzip?: boolean;
  maxUploadBytes?: number;
  /** Internal - used by {@link createReporter} to surface progress events. */
  onEvent?: (name: string, data: Record<string, unknown>) => void;
}

export interface PublishResult {
  summary: Summary;
  published: number;
  testRunId?: string;
  url?: string;
  dryRun: boolean;
  timings: { discoverMs: number; parseMs: number; uploadMs: number };
}

export function loadConfig(configPath?: string, overrides?: Partial<TestrixConfig>): TestrixConfig;
export function resolveConfig(fileConfig?: Record<string, unknown>): TestrixConfig;
export const DEFAULT_API_URL: string;

export function discoverReportFiles(config: TestrixConfig): string[];
export function parseReports(
  files: string[],
  options?: { maxCases?: number },
): Promise<ParseReportsResult>;
export function buildPayload(
  config: TestrixConfig,
  data: {
    testCases: TestCaseRecord[];
    suites: string[];
    startTime?: string | null;
    endTime?: string | null;
  },
): Payload;
export function publishTestReports(
  config: TestrixConfig,
  options?: PublishOptions,
): Promise<PublishResult>;

export interface Reporter {
  on(event: 'discover', handler: (data: { files: string[] }) => void): Reporter;
  on(event: 'parse', handler: (data: { summary: Summary; truncated: boolean }) => void): Reporter;
  on(event: 'upload:start', handler: (data: { count: number }) => void): Reporter;
  on(event: 'upload:done', handler: (data: { testRunId?: string; url?: string }) => void): Reporter;
  on(event: 'done', handler: (data: { summary: Summary; dryRun: true }) => void): Reporter;
  on(event: string, handler: (data: Record<string, unknown>) => void): Reporter;
  run(options?: PublishOptions): Promise<PublishResult>;
}
export function createReporter(config: TestrixConfig): Reporter;

// One `parseX` (buffered) + `streamX` (async generator) pair per format.
// All share the ParseResult / TestCaseRecord shapes above.
type ParseFn = (filePath: string) => Promise<ParseResult>;
type StreamFn = (
  filePath: string,
  acc?: { startTime?: string | null; endTime?: string | null },
) => AsyncGenerator<TestCaseRecord>;

export const parseJUnit: ParseFn;
export const streamJUnit: StreamFn;
export const parsePlaywrightJson: ParseFn;
export const streamPlaywrightJson: StreamFn;
export const parseTestNG: ParseFn;
export const streamTestNG: StreamFn;
export const parseNUnit: ParseFn;
export const streamNUnit: StreamFn;
export const parseMochawesome: ParseFn;
export const streamMochawesome: StreamFn;
export const parseCtrf: ParseFn;
export const streamCtrf: StreamFn;
export const parseK6: ParseFn;
export const streamK6: StreamFn;
export const parseTap: ParseFn;
export const streamTap: StreamFn;
export const parseJMeter: ParseFn;
export const streamJMeter: StreamFn;
export const parseTrx: ParseFn;
export const streamTrx: StreamFn;
export const parseHtml: ParseFn;
export const parseExcel: ParseFn;

export function parserForFile(filePath: string): ParseFn | null;
export function streamParserForFile(filePath: string): StreamFn | null;
