'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseJUnit, streamJUnit } = require('../src/parsers');
const { parseReports } = require('../src/publisher');
const { clampField, MAX_FIELD_BYTES } = require('../src/limits');

const tmpFile = (name, body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testrix-junit-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return { file, dir };
};

/** Build a JUnit report with `n` passing test cases. */
function bigReport(n) {
  let xml = `<?xml version="1.0"?>\n<testsuites tests="${n}" failures="0" errors="0">\n`;
  xml += `<testsuite name="load.spec.ts" timestamp="2026-09-04T10:00:00.000Z" time="1" tests="${n}">\n`;
  for (let i = 0; i < n; i += 1)
    xml += `<testcase name="case ${i}" classname="load.spec.ts" time="0.001"/>\n`;
  xml += '</testsuite>\n</testsuites>\n';
  return xml;
}

test('streamJUnit yields records incrementally without building a DOM', async () => {
  const { file, dir } = tmpFile('big.xml', bigReport(5000));
  try {
    let count = 0;
    for await (const rec of streamJUnit(file, {})) {
      count += 1;
      if (count === 1) assert.equal(rec.title, 'case 0'); // records arrive as they parse
    }
    assert.equal(count, 5000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseReports enforces maxCases and reports truncation', async () => {
  const { file, dir } = tmpFile('big.xml', bigReport(3000));
  try {
    const res = await parseReports([file], { maxCases: 1000 });
    assert.equal(res.testCases.length, 1000);
    assert.equal(res.summary.total, 1000);
    assert.equal(res.truncated, true);

    const full = await parseReports([file], { maxCases: 0 });
    assert.equal(full.testCases.length, 3000);
    assert.equal(full.truncated, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('oversized failure output is clamped', async () => {
  const huge = 'x'.repeat(MAX_FIELD_BYTES * 3);
  const xml =
    `<?xml version="1.0"?><testsuites><testsuite name="s" tests="1" failures="1">` +
    `<testcase name="big fail" classname="s" time="0.1"><failure message="boom">${huge}</failure>` +
    `</testcase></testsuite></testsuites>`;
  const { file, dir } = tmpFile('huge.xml', xml);
  try {
    const { testCases } = await parseJUnit(file);
    assert.equal(testCases[0].status, 'failed');
    assert.ok(testCases[0].errorStack.length <= MAX_FIELD_BYTES);
    assert.match(testCases[0].errorStack, /\[truncated\]$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a JUnit report with DTD entity definitions is rejected (billion-laughs guard)', async () => {
  const xml =
    `<?xml version="1.0"?>\n<!DOCTYPE testsuites [<!ENTITY lol "lol">\n` +
    `<!ENTITY lol2 "&lol;&lol;&lol;">]>\n<testsuites><testsuite name="s" tests="0"/></testsuites>`;
  const { file, dir } = tmpFile('bomb.xml', xml);
  try {
    await assert.rejects(() => parseJUnit(file), /DTD entities/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a truncated / malformed XML file is rejected cleanly, not hung or crashed', async () => {
  // Root element never closes - e.g. the writer was killed mid-run.
  const xml =
    '<?xml version="1.0"?>\n<testsuites><testsuite name="s" tests="1">' +
    '<testcase name="a" time="0.1">';
  const { file, dir } = tmpFile('truncated.xml', xml);
  try {
    await assert.rejects(() => parseJUnit(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a huge attribute value is clamped rather than bloating the record', async () => {
  const hugeName = 'n'.repeat(1_000_000);
  const xml =
    `<?xml version="1.0"?><testsuites><testsuite name="s" tests="1">` +
    `<testcase name="${hugeName}" classname="${hugeName}" time="0.01"/></testsuite></testsuites>`;
  const { file, dir } = tmpFile('huge-attr.xml', xml);
  try {
    const { testCases } = await parseJUnit(file);
    assert.equal(testCases.length, 1);
    assert.ok(testCases[0].title.length < hugeName.length);
    assert.ok(testCases[0].file.length < hugeName.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clampField leaves short strings untouched and marks truncation', () => {
  assert.equal(clampField('short'), 'short');
  assert.equal(clampField('', 10), '');
  const out = clampField('y'.repeat(100), 20);
  assert.ok(out.length <= 20);
  assert.match(out, /\[truncated\]$/);
});
