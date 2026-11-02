import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionBus } from '../lib/bus.js';
import { parseEnvelope } from '../lib/envelope.js';
import {
  AttentionLedger,
  RoleRegistry,
  TaskLedger,
  samePath,
} from '../lib/coordination.js';

const CLOCK = 1760000000000;

/** Role, task, and attention ledgers need nothing from the Host. */
function ledgers(options = {}) {
  let counter = 0;
  const idFactory = () => `id${String(++counter).padStart(6, '0')}`;
  const clock = () => CLOCK;
  const tasks = options.tasks ?? new TaskLedger({ clock, idFactory });
  const attention = new AttentionLedger({ clock, idFactory, tasks });
  return { tasks, attention };
}

/** Minimal Host double for the bus-level coordination tests. */
function createHost() {
  const sessions = [
    { sessionId: 'session-main0001', cwd: 'C:\\work\\a', updatedAt: CLOCK, running: false, agentAvailable: true, projections: { values: { title: 'Main' } } },
    { sessionId: 'session-dev0002', cwd: 'C:\\work\\a', updatedAt: CLOCK - 1000, running: true, agentAvailable: true, projections: { values: { title: 'Frontend dev' } } },
    { sessionId: 'session-other003', cwd: 'C:\\work\\b', updatedAt: CLOCK - 2000, running: false, agentAvailable: true, projections: { values: { title: 'Other workspace' } } },
  ];
  const delivered = [];
  const created = [];
  return {
    sessions,
    delivered,
    created,
    sessionController: {
      async list() {
        return { items: sessions };
      },
      async prompt(request) {
        delivered.push(request);
        return { accepted: true };
      },
      async create(request) {
        created.push(request);
        const sessionId = `session-spawn${String(created.length).padStart(3, '0')}`;
        sessions.push({ sessionId, cwd: request.cwd ?? 'C:\\work\\a', updatedAt: CLOCK, running: false, agentAvailable: true, projections: { values: {} } });
        return { sessionId };
      },
      async inspect() {
        return { meta: { id: 'session-main0001', cwd: 'C:\\work\\a' }, inheritedEventCount: 0, events: [] };
      },
    },
    get(name) {
      if (name !== 'workspaceRegistry') return undefined;
      return {
        list: () => [
          { id: 'ws-a', path: 'C:\\work\\a', title: 'Workspace A' },
          { id: 'ws-b', path: 'C:\\work\\b', title: 'Workspace B' },
        ],
      };
    },
  };
}

/** Build a bus over a Host double. */
function createBus(host, config = {}) {
  let counter = 0;
  return new SessionBus({
    ctx: host,
    config: { audit: false, persistState: false, spoolLongMessages: false, ...config },
    persist: false,
    clock: () => CLOCK,
    idFactory: () => `msg${String(++counter).padStart(9, '0')}`,
  });
}

const senderMain = { id: 'session-main0001', title: 'Main', cwd: 'C:\\work\\a' };
const senderDev = { id: 'session-dev0002', title: 'Frontend dev', cwd: 'C:\\work\\a' };
const senderOther = { id: 'session-other003', title: 'Other workspace', cwd: 'C:\\work\\b' };

test('samePath normalizes separators, trailing slashes and win32 case', () => {
  assert.equal(samePath('C:\\work\\a', 'c:/work/a/'), true);
  assert.equal(samePath('/work/a', '/work/a/'), true);
  assert.equal(samePath('C:\\work\\a', 'C:\\work\\b'), false);
});

test('RoleRegistry keeps one main per workspace and module ownership on dev roles', () => {
  const roles = new RoleRegistry({ clock: () => CLOCK });
  const main = roles.set({ sessionId: 'session-a', role: 'main', workspace: 'C:\\work\\a', cwd: 'C:\\work\\a' });
  assert.equal(main.role, 'main');
  assert.equal(roles.main({ cwd: 'C:\\work\\a' }).sessionId, 'session-a');
  assert.throws(
    () => roles.set({ sessionId: 'session-b', role: 'main', workspace: 'C:\\work\\a', cwd: 'C:\\work\\a' }),
    /\[main_exists\]/,
  );
  const forced = roles.set({ sessionId: 'session-b', role: 'main', workspace: 'C:\\work\\a', force: true });
  assert.equal(forced.sessionId, 'session-b');
  assert.equal(roles.mains({ cwd: 'C:\\work\\a' }).length, 1);

  const dev = roles.set({ sessionId: 'session-dev', role: 'dev', module: 'Gys_Frontend', workspace: 'C:\\work\\a', cwd: 'C:\\work\\a' });
  assert.equal(dev.module, 'Gys_Frontend');
  assert.equal(roles.get('session-dev').role, 'dev');
  assert.equal(roles.list({ role: 'dev' }).length, 1);
  assert.equal(roles.list()[0].role, 'main');
  assert.equal(roles.remove('session-dev'), true);
  assert.equal(roles.remove('session-dev'), false);
  assert.throws(() => roles.set({ role: 'queen', sessionId: 'session-x' }), /\[invalid_role\]/);
});

test('TaskLedger moves through claim, blocked, ready and done with evidence', () => {
  const { tasks } = ledgers();
  const opened = tasks.create({ title: 'Fix the invoice filter', module: 'backend', createdBy: 'session-main0001', note: 'ship by Friday' });
  assert.equal(opened.status, 'open');
  assert.equal(opened.openAttentions, 0);
  assert.equal(tasks.get(opened.taskId).title, 'Fix the invoice filter');
  assert.throws(() => tasks.get('t-missing'), /\[task_not_found\]/);

  const claimed = tasks.claim({ taskId: opened.taskId, by: 'session-dev0002' });
  assert.equal(claimed.status, 'in_progress');
  assert.equal(claimed.assignee, 'session-dev0002');
  assert.throws(
    () => tasks.claim({ taskId: opened.taskId, by: 'session-other003' }),
    /\[task_owned\]/,
  );
  assert.throws(
    () => tasks.update({ taskId: opened.taskId, by: 'session-dev0002', status: 'ready' }),
    /\[evidence_required\]/,
  );
  const ready = tasks.update({
    taskId: opened.taskId,
    by: 'session-dev0002',
    status: 'ready',
    evidence: 'node --test test/invoices.test.mjs: 12 passed',
  });
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.evidence, ['node --test test/invoices.test.mjs: 12 passed']);
  assert.throws(
    () => tasks.update({ taskId: opened.taskId, by: 'session-dev0002' }),
    /\[empty_update\]/,
  );
  const done = tasks.update({ taskId: opened.taskId, by: 'session-dev0002', status: 'done', note: 'merged' });
  assert.equal(done.status, 'done');
  assert.notEqual(done.closedAt, undefined);
  assert.equal(tasks.list({ status: 'done' }).total, 1);
  assert.equal(tasks.list({ status: 'active' }).total, 0);
  assert.throws(
    () => tasks.update({ taskId: opened.taskId, by: 'session-main0001', status: 'ready', evidence: 'x' }),
    /\[task_closed\]/,
  );
});

test('AttentionLedger blocks the task, answers it, and resumes the task', () => {
  const { tasks, attention } = ledgers();
  const task = tasks.create({ title: 'Pick a date format', createdBy: 'session-main0001' });
  assert.throws(
    () => attention.create({ taskId: 't-missing', question: 'which one?', askedBy: 'session-dev0002' }),
    /\[task_not_found\]/,
  );
  assert.throws(
    () => attention.create({ taskId: task.taskId, question: '   ', askedBy: 'session-dev0002' }),
    /\[invalid_question\]/,
  );
  const asked = attention.create({
    taskId: task.taskId,
    question: 'Which date format should the invoice list use?',
    options: ['YYYY-MM-DD', 'MM/DD/YYYY'],
    recommendation: 'YYYY-MM-DD, matching the rest of the platform',
    askedBy: 'session-dev0002',
  });
  assert.equal(asked.status, 'open');
  assert.equal(tasks.get(task.taskId).status, 'blocked');
  assert.equal(tasks.get(task.taskId).openAttentions, 1);
  assert.equal(attention.list({ status: 'open' }).total, 1);

  const answered = attention.answer({ attentionId: asked.attentionId, answer: 'YYYY-MM-DD', answeredBy: 'session-main0001' });
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answer, 'YYYY-MM-DD');
  assert.equal(tasks.get(task.taskId).status, 'in_progress');
  assert.equal(tasks.get(task.taskId).openAttentions, 0);
  assert.throws(
    () => attention.answer({ attentionId: asked.attentionId, answer: 'later', answeredBy: 'session-main0001' }),
    /\[attention_closed\]/,
  );
});

test('bus.role registers a main Session, and roles() reports the live role table', async () => {
  const host = createHost();
  const bus = createBus(host);
  const registered = await bus.role({ role: 'main', sender: senderMain });
  assert.equal(registered.sessionId, 'session-main0001');
  assert.equal(registered.registered.role, 'main');
  assert.equal(registered.registered.workspace, 'C:\\work\\a');
  assert.match(registered.note, /main Session/);

  const dev = await bus.role({ role: 'dev', module: 'Gys_Frontend', sender: senderDev });
  assert.equal(dev.registered.module, 'Gys_Frontend');

  const listed = await bus.roles({ sender: senderDev });
  assert.equal(listed.total, 2);
  assert.equal(listed.roles[0].role, 'main');
  assert.equal(listed.roles.find((row) => row.sessionId === 'session-dev0002').mine, true);
  assert.match(listed.note, /2 role/);

  const cleared = await bus.role({ clear: true, sender: senderDev });
  assert.equal(cleared.cleared, true);
  assert.equal((await bus.roles({ sender: senderDev })).total, 1);
  await assert.rejects(() => bus.role({ role: 'main' }), /\[no_sender\]/);
});

test('bus.send({ to: "main" }) reaches the registered main Session', async () => {
  const host = createHost();
  const bus = createBus(host);
  await bus.role({ role: 'main', sender: senderMain });
  const receipt = await bus.send({ to: 'main', message: 'finished the filter', sender: senderDev });
  assert.equal(receipt.sessionId, 'session-main0001');
  assert.equal(receipt.hop, 1);
  assert.equal(host.delivered.length, 1);
  assert.equal(host.delivered[0].sessionId, 'session-main0001');
});

test('a title that happens to be "Main" still resolves by name before the role alias', async () => {
  const host = createHost();
  const bus = createBus(host);
  await bus.role({ role: 'main', sender: senderMain });
  const receipt = await bus.send({ to: 'Main', message: 'ping', sender: senderDev });
  assert.equal(receipt.sessionId, 'session-main0001');
});

test('bus.send({ to: "main" }) without a registered main explains what to do', async () => {
  const host = createHost();
  const bus = createBus(host);
  await assert.rejects(
    () => bus.send({ to: '@main', message: 'ping', sender: senderDev }),
    /\[no_main\]/,
  );
});

test('bus.spawn registers the role and refuses a second main in one workspace', async () => {
  const host = createHost();
  const bus = createBus(host);
  const spawned = await bus.spawn({
    message: 'coordinate the workspace',
    cwd: 'C:\\work\\a',
    preset: 'main-session',
    role: 'main',
    spawnKey: 'main-a',
    sender: senderMain,
  });
  assert.equal(spawned.role, 'main');
  assert.equal(spawned.workspace, 'C:\\work\\a');
  assert.equal(host.created[0].agentPreset, 'main-session');

  const dev = await bus.spawn({
    message: 'own the frontend',
    cwd: 'C:\\work\\a',
    role: 'dev',
    module: 'Gys_Frontend',
    spawnKey: 'dev-frontend',
    sender: senderMain,
  });
  assert.equal(dev.role, 'dev');
  assert.equal(dev.module, 'Gys_Frontend');

  await assert.rejects(
    () => bus.spawn({ message: 'another main', cwd: 'C:\\work\\a', role: 'main', spawnKey: 'main-again', sender: senderMain }),
    /\[main_exists\]/,
  );
  await assert.rejects(
    () => bus.spawn({ message: 'bad role', cwd: 'C:\\work\\a', role: 'queen', sender: senderMain }),
    /\[invalid_role\]/,
  );
});

test('bus.task runs the ledger end to end on the bus', async () => {
  const host = createHost();
  const bus = createBus(host);
  const created = await bus.task({ action: 'create', title: 'Fix the invoice filter', module: 'backend', sender: senderMain });
  assert.equal(created.task.status, 'open');

  const claimed = await bus.task({ action: 'claim', taskId: created.task.taskId, sender: senderDev });
  assert.equal(claimed.task.status, 'in_progress');
  await assert.rejects(
    () => bus.task({ action: 'update', taskId: created.task.taskId, status: 'ready', sender: senderDev }),
    /\[evidence_required\]/,
  );
  const ready = await bus.task({
    action: 'update',
    taskId: created.task.taskId,
    status: 'ready',
    evidence: ['git show 86ca66f', 'npm test: 151 passed'],
    sender: senderDev,
  });
  assert.equal(ready.task.status, 'ready');
  assert.equal(ready.task.evidence.length, 2);

  const listed = await bus.task({ action: 'list', status: 'active', sender: senderMain });
  assert.equal(listed.total, 1);
  assert.equal(listed.tasks[0].taskId, created.task.taskId);
  await assert.rejects(() => bus.task({ action: 'dance', sender: senderMain }), /\[invalid_action\]/);
  await assert.rejects(() => bus.task({ action: 'list' }), /\[no_sender\]/);
});

test('bus.attention asks the main Session, then records the human answer', async () => {
  const host = createHost();
  const bus = createBus(host);
  await bus.role({ role: 'main', sender: senderMain });
  const task = await bus.task({ action: 'create', title: 'Pick the report layout', sender: senderMain });

  const asked = await bus.attention({
    action: 'ask',
    taskId: task.task.taskId,
    question: 'Which layout should the monthly report use?',
    options: ['table', 'chart'],
    recommendation: 'table, matching the existing pages',
    sender: senderDev,
  });
  assert.equal(asked.attention.status, 'open');
  assert.equal(asked.delivered, true);
  assert.equal(host.delivered.length, 1);
  assert.equal(host.delivered[0].sessionId, 'session-main0001');
  const envelope = parseEnvelope(host.delivered[0].content[0].text);
  assert.equal(envelope.kind, 'question');
  assert.match(envelope.body, /Which layout/);
  assert.equal((await bus.task({ action: 'get', taskId: task.task.taskId, sender: senderMain })).task.status, 'blocked');

  const answered = await bus.attention({
    action: 'answer',
    attentionId: asked.attention.attentionId,
    answer: 'table',
    sender: senderMain,
  });
  assert.equal(answered.attention.status, 'answered');
  assert.equal((await bus.task({ action: 'get', taskId: task.task.taskId, sender: senderMain })).task.status, 'in_progress');
  assert.equal((await bus.attention({ action: 'list', sender: senderMain })).total, 0);
  await assert.rejects(() => bus.attention({ action: 'list' }), /\[no_sender\]/);
  await assert.rejects(
    () => bus.attention({ action: 'ask', question: 'no task', sender: senderDev }),
    /\[invalid_task\]/,
  );
});
