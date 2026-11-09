/**
 * Tests for v1.0: a requirement is a task. Covers the task layer (acceptance
 * criteria, constraints, session binding, last exchange), the task stamp on
 * outbound envelopes and its inheritance across a thread, spawn sessions
 * bound to one requirement, task-filtered read/threads/find, and the per-turn
 * task card injected through the `agent/pre-step` waterfall.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionBus } from '../lib/bus.js';
import { registerTools } from '../lib/tools.js';
import { parseEnvelope } from '../lib/envelope.js';

const SELF = 'session-aaa';
const PEER = 'session-bbb';
const THIRD = 'session-ccc';
const BASE = 1760000000000;

const senderA = { id: SELF, title: 'A', cwd: 'C:\\work\\a' };
const senderB = { id: PEER, title: 'B', cwd: 'C:\\work\\b' };

/** Minimal Host double with three Sessions and an event hook. */
function createHost(options = {}) {
  const sessions = options.sessions ?? [
    { sessionId: SELF, cwd: 'C:\\work\\a', updatedAt: 1000, running: false, agentAvailable: true, projections: { values: { title: 'A' } } },
    { sessionId: PEER, cwd: 'C:\\work\\b', updatedAt: 900, running: false, agentAvailable: true, projections: { values: { title: 'B' } } },
    { sessionId: THIRD, cwd: 'C:\\work\\c', updatedAt: 800, running: false, agentAvailable: true, projections: { values: { title: 'C' } } },
  ];
  const prompts = [];
  const created = [];
  const handlers = [];
  const live = new Map(sessions.map((row) => [row.sessionId, { id: row.sessionId }]));
  const presetOf = new Map(Object.entries({ [SELF]: 'danger-full-access', [PEER]: 'workspace-write', [THIRD]: 'workspace-write' }));
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on: (name, handler) => {
      Object.defineProperty(handler, 'eventName', { value: name });
      handlers.push(handler);
      return () => {};
    },
    get: (key) => (key === 'workspaceRegistry'
      ? { list: () => [{ id: 'ws-a', path: 'C:\\work\\a', title: 'A' }] }
      : undefined),
    sessions: { get: (id) => live.get(id) },
    agents: { get: () => ({ status: 'idle', inbox: { nextTurn: [], nextStep: [] } }) },
    permissionPresets: {
      current: (session) => presetOf.get(session.id),
      set: (session, name) => { presetOf.set(session.id, name); },
    },
    sessionController: {
      list: async () => ({ items: sessions }),
      prompt: async (request) => { prompts.push(request); return { accepted: true }; },
      inspect: async (sessionId) => {
        if (options.inspect !== undefined) return options.inspect(sessionId);
        if (!live.has(sessionId)) throw new Error(`session "${sessionId}" not found`);
        return { meta: { id: sessionId }, inheritedEventCount: 0, events: options.events ?? [] };
      },
      create: async (request) => {
        const id = request.sessionId ?? 'session-new1';
        created.push(request);
        if (!live.has(id)) {
          live.set(id, { id });
          sessions.push({ sessionId: id, cwd: request.cwd ?? 'C:\\work\\a', updatedAt: 2000 });
        }
        return { sessionId: id };
      },
    },
    prompts,
    created,
    sessionRows: sessions,
    presetOf,
    handlers,
  };
  return ctx;
}

/** Mount the bus and expose the registered tools by name. */
function mount(host, config = {}) {
  const registered = [];
  host.tools = { register: (definition) => { registered.push(definition); return () => {}; } };
  host.inject = (deps, callback) => { callback({ systemPrompt: { section: () => () => {} } }); };
  const bus = createSessionBus({
    ctx: host,
    config: { audit: false, persistState: false, spoolLongMessages: false, ...config },
    persist: false,
    clock: () => BASE,
  });
  bus.attach(host);
  registerTools(host, bus);
  return { bus, tools: Object.fromEntries(registered.map((tool) => [tool.name, tool])) };
}

/** The envelope text of the most recent delivery. */
function lastDelivery(host) {
  const prompt = host.prompts.at(-1);
  assert.ok(prompt !== undefined, 'expected a delivery');
  return prompt.content[0].text;
}

/** The `agent/pre-step` listener the bus registered. */
function preStepHandler(host) {
  const handler = host.handlers.find((item) => item.eventName === 'agent/pre-step');
  assert.ok(handler !== undefined, 'the bus must listen to agent/pre-step');
  return handler;
}

// --- the task layer --------------------------------------------------------

test('a task carries its acceptance criteria and constraints', async () => {
  const { bus } = mount(createHost());
  const opened = await bus.task({
    action: 'create',
    title: 'Ship the refund fix',
    acceptance: ['refund row appears', 'audit log line written'],
    constraints: 'no production deploy without approval',
    sender: senderA,
  });
  assert.deepEqual(opened.task.acceptance, ['refund row appears', 'audit log line written']);
  assert.deepEqual(opened.task.constraints, ['no production deploy without approval']);
  assert.equal(opened.task.status, 'open');
});

test('updating a task replaces its acceptance criteria and constraints', async () => {
  const { bus } = mount(createHost());
  const opened = await bus.task({ action: 'create', title: 'Ship it', acceptance: ['old'], sender: senderA });
  const updated = await bus.task({
    action: 'update',
    taskId: opened.task.taskId,
    acceptance: ['new criterion'],
    constraints: ['no schema migration'],
    sender: senderA,
  });
  assert.deepEqual(updated.task.acceptance, ['new criterion']);
  assert.deepEqual(updated.task.constraints, ['no schema migration']);
});

test('bind attaches the owning Session and thread; touch records the last exchange', async () => {
  const { bus } = mount(createHost());
  const opened = await bus.task({ action: 'create', title: 'Bound work', sender: senderA });
  const bound = bus.taskLedger.bind({ taskId: opened.task.taskId, sessionId: PEER, threadId: 't-1', workspace: 'C:\\work\\b' });
  assert.equal(bound.sessionId, PEER);
  assert.equal(bound.assignee, PEER);
  assert.deepEqual(bound.threadIds, ['t-1']);
  assert.equal(bound.workspace, 'C:\\work\\a', 'bind fills gaps; it never rewrites the workspace the task was opened in');
  const touched = bus.taskLedger.touch({ taskId: opened.task.taskId, from: PEER, kind: 'task', preview: 'started' });
  assert.equal(touched.last.from, PEER);
  assert.equal(touched.last.preview, 'started');
  assert.equal(touched.last.at, new Date(BASE).toISOString());
});

// --- the task stamp on messages -------------------------------------------

test('bus_send stamps the task into the envelope and records the exchange', async () => {
  const host = createHost();
  const { bus } = mount(host);
  const opened = await bus.task({ action: 'create', title: 'Wire the job', sender: senderA });
  const receipt = await bus.send({ to: PEER, message: 'please wire it', sender: senderA, taskId: opened.task.taskId });
  assert.equal(receipt.task.taskId, opened.task.taskId);
  assert.equal(receipt.task.title, 'Wire the job');
  const envelope = parseEnvelope(lastDelivery(host));
  assert.equal(envelope.taskId, opened.task.taskId);
  assert.equal(envelope.taskTitle, 'Wire the job');
  const view = (await bus.task({ action: 'get', taskId: opened.task.taskId, sender: senderA })).task;
  assert.equal(view.last.from, SELF);
  assert.equal(view.last.threadId, receipt.threadId);
});

test('a follow-up message inherits the task from its thread', async () => {
  const host = createHost();
  const { bus, tools } = mount(host);
  const opened = await bus.task({ action: 'create', title: 'Inherited', sender: senderA });
  const first = await bus.send({ to: PEER, message: 'first', sender: senderA, taskId: opened.task.taskId });
  const second = await bus.send({ to: PEER, message: 'second', sender: senderA, thread: first.threadId });
  assert.equal(second.task.taskId, opened.task.taskId);
  assert.equal(parseEnvelope(lastDelivery(host)).taskId, opened.task.taskId);
  const threads = await bus.threads({ sender: senderA });
  assert.equal(threads.threads[0].taskId, opened.task.taskId);
  assert.equal(threads.threads[0].taskTitle, 'Inherited');
  assert.equal(typeof tools.bus_threads, 'object');
});

test('a single active task assigned to the sender is picked automatically', async () => {
  const host = createHost();
  const { bus } = mount(host);
  const opened = await bus.task({ action: 'create', title: 'Only task', assignee: SELF, sender: senderA });
  const receipt = await bus.send({ to: PEER, message: 'auto', sender: senderA });
  assert.equal(receipt.task.taskId, opened.task.taskId);
});

test('two active tasks do not guess which one a message belongs to', async () => {
  const host = createHost();
  const { bus } = mount(host);
  await bus.task({ action: 'create', title: 'One', assignee: SELF, sender: senderA });
  await bus.task({ action: 'create', title: 'Two', assignee: SELF, sender: senderA });
  const receipt = await bus.send({ to: PEER, message: 'ambiguous', sender: senderA });
  assert.equal(receipt.task, undefined);
  assert.equal(parseEnvelope(lastDelivery(host)).taskId, undefined);
});

test('an unknown task id is refused instead of guessed', async () => {
  const { bus } = mount(createHost());
  await assert.rejects(
    () => bus.send({ to: PEER, message: 'hi', sender: senderA, taskId: 't-missing' }),
    /\[task_not_found\]/,
  );
});

// --- one requirement, one Session -----------------------------------------

test('bus_spawn binds the new Session to the task and reuses it by default key', async () => {
  const host = createHost();
  const { bus } = mount(host);
  const opened = await bus.task({ action: 'create', title: 'Requirement session', sender: senderA });
  const first = await bus.spawn({
    message: 'own this requirement',
    cwd: 'C:\\work\\a',
    role: 'dev',
    module: 'billing',
    taskId: opened.task.taskId,
    sender: senderA,
  });
  assert.equal(first.created, true);
  assert.equal(first.task.taskId, opened.task.taskId);
  const view = (await bus.task({ action: 'get', taskId: opened.task.taskId, sender: senderA })).task;
  assert.equal(view.sessionId, first.sessionId);
  assert.equal(view.assignee, first.sessionId);
  assert.equal(view.module, 'billing');

  const again = await bus.spawn({
    message: 'own this requirement',
    cwd: 'C:\\work\\a',
    role: 'dev',
    module: 'billing',
    taskId: opened.task.taskId,
    sender: senderA,
  });
  assert.equal(again.created, false, 'the default spawn key is the task, so the Session is reused');
  assert.equal(again.sessionId, first.sessionId);
});

test('bus_threads reports the task behind each thread', async () => {
  const host = createHost();
  const { bus } = mount(host);
  const opened = await bus.task({ action: 'create', title: 'Threaded', sender: senderA });
  await bus.send({ to: PEER, message: 'hello', sender: senderA, taskId: opened.task.taskId });
  const listed = await bus.threads({ sender: senderA });
  assert.equal(listed.threads[0].taskId, opened.task.taskId);
  assert.equal(listed.threads[0].taskTitle, 'Threaded');
  assert.equal(listed.threads[0].taskStatus, 'open');
});

// --- reviewing one requirement --------------------------------------------

test('bus_read returns only the messages of one task', async () => {
  const host = createHost();
  const { bus } = mount(host);
  const opened = await bus.task({ action: 'create', title: 'Readable', sender: senderA });
  await bus.send({ to: PEER, message: 'with task', sender: senderA, taskId: opened.task.taskId });
  await bus.send({ to: PEER, message: 'without task', sender: senderA, newThread: true });
  const withTask = host.prompts.at(-2).content[0].text;
  const withoutTask = host.prompts.at(-1).content[0].text;
  host.sessionController.inspect = async () => ({
    meta: { id: PEER },
    inheritedEventCount: 0,
    events: [
      { type: 'user/message', seq: 1, time: BASE + 1, data: { content: [{ type: 'text', text: withTask }] } },
      { type: 'user/message', seq: 2, time: BASE + 2, data: { content: [{ type: 'text', text: withoutTask }] } },
    ],
  });
  const filtered = await bus.read({ session: PEER, sender: senderA, task: opened.task.taskId });
  assert.equal(filtered.task, opened.task.taskId);
  assert.equal(filtered.returned, 1);
  assert.equal(filtered.messages[0].taskId, opened.task.taskId);
  assert.match(filtered.messages[0].text, /with task/);
});

test('bus_find narrows candidates to the Sessions of one task', async () => {
  const host = createHost();
  const { bus } = mount(host);
  const opened = await bus.task({ action: 'create', title: 'Findable', assignee: PEER, sender: senderA });
  const found = await bus.find({ question: 'B', sender: senderA, task: opened.task.taskId });
  assert.equal(found.task.taskId, opened.task.taskId);
  assert.equal(found.returned, 1);
  assert.equal(found.candidates[0].sessionId, PEER);
});

// --- the per-turn task card ------------------------------------------------

test('the task card is injected before the first step of an assigned Session', async () => {
  const host = createHost();
  const { bus } = mount(host);
  const opened = await bus.task({
    action: 'create',
    title: 'Inject me',
    assignee: PEER,
    acceptance: ['tests pass'],
    constraints: 'no production deploy',
    sender: senderA,
  });
  assert.equal(bus.config.taskCards, true);
  const decide = async () => ({ kind: 'enter', messages: [] });
  const carded = await preStepHandler(host)({ agent: { id: PEER }, step: 1, messages: [] }, decide);
  assert.equal(carded.messages.length, 1);
  assert.equal(carded.messages[0].source.kind, 'session-bus-task-card');
  assert.deepEqual(carded.messages[0].source.taskIds, [opened.task.taskId]);
  const text = carded.messages[0].content[0].text;
  assert.match(text, /\[session-bus task card\]/);
  assert.match(text, new RegExp(opened.task.taskId));
  assert.match(text, /Inject me/);
  assert.match(text, /tests pass/);
  assert.match(text, /no production deploy/);
});

test('the coordinator card lists the live requirements it owns', async () => {
  const host = createHost();
  const { bus } = mount(host);
  const opened = await bus.task({ action: 'create', title: 'Owned requirement', sender: senderA });
  const decided = await preStepHandler(host)({ agent: { id: SELF }, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }));
  assert.equal(decided.messages.length, 1);
  const text = decided.messages[0].content[0].text;
  assert.match(text, /Live requirements you own/);
  assert.match(text, new RegExp(opened.task.taskId));
});

test('no card is injected without a live task, after step 1, or when one is already present', async () => {
  const host = createHost();
  const { bus } = mount(host);
  const decide = async () => ({ kind: 'enter', messages: [] });
  const handler = preStepHandler(host);
  assert.deepEqual(await handler({ agent: { id: PEER }, step: 1, messages: [] }, decide), { kind: 'enter', messages: [] });

  await bus.task({ action: 'create', title: 'Late card', assignee: PEER, sender: senderA });
  assert.deepEqual(
    await handler({ agent: { id: PEER }, step: 2, messages: [] }, decide),
    { kind: 'enter', messages: [] },
  );
  const existing = { id: 'm-1', role: 'user', content: [], source: { kind: 'session-bus-task-card' } };
  const kept = await handler({ agent: { id: PEER }, step: 1, messages: [existing] }, async () => ({ kind: 'enter', messages: [existing] }));
  assert.equal(kept.messages.length, 1);
  assert.equal(kept.messages[0], existing);

  const rejected = await handler({ agent: { id: PEER }, step: 1, messages: [] }, async () => ({ kind: 'reject' }));
  assert.deepEqual(rejected, { kind: 'reject' });
});

test('taskCards: false turns the card off', async () => {
  const host = createHost();
  const { bus } = mount(host, { taskCards: false });
  await bus.task({ action: 'create', title: 'Suppressed', assignee: PEER, sender: senderA });
  const decided = await preStepHandler(host)(
    { agent: { id: PEER }, step: 1, messages: [] },
    async () => ({ kind: 'enter', messages: [] }),
  );
  assert.equal(decided.messages.length, 0);
});
