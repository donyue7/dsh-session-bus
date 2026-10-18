import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSessionQuery, resolveWorkspaceQuery, sameWorkspace, normalizeForCompare } from '../lib/resolve.js';

const rows = [
  { sessionId: 'session-aaaa1111', title: 'Fix the parser', cwd: 'C:\\work\\project-a', targetable: true },
  { sessionId: 'session-bbbb2222', title: 'Fix the parser', cwd: 'C:\\work\\project-b', targetable: true },
  { sessionId: 'session-cccc3333', title: 'Docs build', cwd: 'C:\\work\\docs', targetable: true },
  { sessionId: 'session-dddd4444', title: undefined, cwd: 'C:\\work\\project-a', targetable: true },
  { sessionId: 'session-eeee5555', title: 'child', cwd: 'C:\\work\\project-a', targetable: false, isSubagent: true },
];

test('exact sessionId wins', () => {
  const outcome = resolveSessionQuery(rows, 'session-cccc3333');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.how, 'id');
  assert.equal(outcome.row.sessionId, 'session-cccc3333');
});

test('a unique id prefix resolves', () => {
  const outcome = resolveSessionQuery(rows, 'session-cccc');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.row.sessionId, 'session-cccc3333');
});

test('an ambiguous title is refused instead of guessed', () => {
  const outcome = resolveSessionQuery(rows, 'Fix the parser');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'ambiguous');
  assert.equal(outcome.candidates.length, 2);
});

test('a working directory substring resolves when it is unique', () => {
  const outcome = resolveSessionQuery(rows, 'docs');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.row.sessionId, 'session-cccc3333');
});

test('an ambiguous cwd substring is refused', () => {
  const outcome = resolveSessionQuery(rows, 'project-a');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'ambiguous');
});

test('self alias resolves to the calling Session', () => {
  const outcome = resolveSessionQuery(rows, 'self', { selfId: 'session-cccc3333' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.row.sessionId, 'session-cccc3333');
  const refused = resolveSessionQuery(rows, '自己', { selfId: 'session-cccc3333', allowSelf: false });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'self-refused');
});

test('a subagent Session is reported as not targetable', () => {
  const outcome = resolveSessionQuery(rows, 'session-eeee5555');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'not-targetable');
  assert.match(outcome.message, /subagent/);
});

test('an unknown reference reports not-found with no candidates', () => {
  const outcome = resolveSessionQuery(rows, 'nothing-like-this');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'not-found');
  assert.deepEqual(outcome.candidates, []);
});

test('an empty reference is refused', () => {
  assert.equal(resolveSessionQuery(rows, '   ').reason, 'empty');
  assert.equal(resolveSessionQuery(rows, undefined).reason, 'empty');
});

test('workspace resolution matches path, title and id', () => {
  const workspaces = [
    { id: 'ws-1', path: 'C:\\work\\project-a', title: 'Project A' },
    { id: 'ws-2', path: 'C:\\work\\docs', title: 'Docs' },
  ];
  assert.equal(resolveWorkspaceQuery(workspaces, 'C:\\work\\docs').workspace.id, 'ws-2');
  assert.equal(resolveWorkspaceQuery(workspaces, 'Project A').workspace.id, 'ws-1');
  assert.equal(resolveWorkspaceQuery(workspaces, 'ws-2').workspace.id, 'ws-2');
  assert.equal(resolveWorkspaceQuery(workspaces, 'c:/WORK/docs/').workspace.id, 'ws-2');
  assert.equal(resolveWorkspaceQuery(workspaces, 'missing').ok, false);
});

test('sameWorkspace ignores case, separators and trailing slashes', () => {
  assert.equal(sameWorkspace('C:\\Work\\A\\', 'c:/work/a'), true);
  assert.equal(sameWorkspace('C:\\work\\a', 'C:\\work\\b'), false);
  assert.equal(sameWorkspace(undefined, undefined), false);
  assert.equal(normalizeForCompare('C:\\Work\\A\\'), 'c:/work/a');
});
