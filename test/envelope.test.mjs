import test from 'node:test';
import assert from 'node:assert/strict';

import { renderEnvelope, parseEnvelope, ENVELOPE_VERSION } from '../lib/envelope.js';

const base = {
  fromId: 'session-aaaa1111',
  fromTitle: 'Fix the parser',
  fromCwd: 'C:\\work\\project-a',
  hop: 1,
  maxHops: 8,
  messageId: 'abc123def456',
  time: '2026-10-16T05:10:04.000Z',
  text: 'please run the suite\nand report failures',
};

test('renderEnvelope writes a parseable header, metadata, body and reply hint', () => {
  const text = renderEnvelope(base);
  const lines = text.split('\n');
  assert.equal(lines[0], `[session-bus v${ENVELOPE_VERSION}] from=session-aaaa1111 hop=1/8 msg=abc123def456`);
  assert.equal(lines[1], 'from-title: Fix the parser');
  assert.equal(lines[2], 'from-cwd: C:\\work\\project-a');
  assert.equal(lines[3], 'sent-at: 2026-10-16T05:10:04.000Z');
  assert.ok(text.includes('--- message ---'));
  assert.ok(text.includes('please run the suite\nand report failures'));
  assert.ok(text.includes('bus_send({ to: "session-aaaa1111"'));
  assert.ok(text.includes('不要只为确认收到而回复'));
});

test('parseEnvelope recovers every field it rendered', () => {
  const parsed = parseEnvelope(renderEnvelope(base));
  assert.ok(parsed);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.from, 'session-aaaa1111');
  assert.equal(parsed.hop, 1);
  assert.equal(parsed.maxHops, 8);
  assert.equal(parsed.messageId, 'abc123def456');
  assert.equal(parsed.fromTitle, 'Fix the parser');
  assert.equal(parsed.fromCwd, 'C:\\work\\project-a');
  assert.equal(parsed.sentAt, '2026-10-16T05:10:04.000Z');
  assert.equal(parsed.body, 'please run the suite\nand report failures');
});

test('parseEnvelope refuses ordinary user text', () => {
  assert.equal(parseEnvelope('hello, please fix the build'), undefined);
  assert.equal(parseEnvelope(''), undefined);
  assert.equal(parseEnvelope(undefined), undefined);
  assert.equal(parseEnvelope('[session-bus] from=x'), undefined);
});

test('parseEnvelope survives multi-line and markdown bodies', () => {
  const body = '## heading\n\n- item one\n- item two\n\n```js\nconst a = 1;\n```';
  const parsed = parseEnvelope(renderEnvelope({ ...base, text: body }));
  assert.ok(parsed);
  assert.equal(parsed.body, body);
});

test('renderEnvelope collapses newlines in metadata lines', () => {
  const text = renderEnvelope({ ...base, fromTitle: 'two\nlines', fromCwd: 'a\r\nb' });
  const lines = text.split('\n');
  assert.equal(lines[1], 'from-title: two lines');
  assert.equal(lines[2], 'from-cwd: a b');
  assert.equal(parseEnvelope(text)?.fromTitle, 'two lines');
});

test('parseEnvelope tolerates a leading blank line', () => {
  const parsed = parseEnvelope(`\n\n${renderEnvelope(base)}`);
  assert.equal(parsed?.from, 'session-aaaa1111');
});
