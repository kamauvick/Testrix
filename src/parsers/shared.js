'use strict';

const emptySummary = () => ({ total: 0, passed: 0, failed: 0, skipped: 0, duration: 0 });

/** Normalise loose status words (pass/fail/skip/…) to passed/failed/skipped. */
function normaliseStatus(raw) {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  if (value === 'pass' || value === 'passed' || value === 'ok' || value === 'success')
    return 'passed';
  if (value === 'fail' || value === 'failed' || value === 'error') return 'failed';
  if (value === 'skip' || value === 'skipped' || value === 'pending') return 'skipped';
  return value || 'passed';
}

/** Increment the matching counter on a summary object. */
function countStatus(summary, status) {
  if (status === 'passed') summary.passed += 1;
  else if (status === 'failed') summary.failed += 1;
  else if (status === 'skipped') summary.skipped += 1;
}

module.exports = { emptySummary, normaliseStatus, countStatus };
