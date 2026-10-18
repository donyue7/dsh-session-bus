/**
 * Tests for the v0.2 conversation model: per-thread hop budgets, thread/re
 * correlation, coded refusals, write scopes, spooling, idempotent spawns, and
 * permission restore. Each block names the review item it answers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionBus, ThreadLedger } from '../lib/bus.js';
import { registerTools } from '../lib/tools.js';
import { parseEnvelope } from '../lib/envelope.js';

const SELF = 'session-aaa';
const PEER = 'session-bbb';
const THIRD = 'session-ccc';

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
  const presetOf = new Map(Object.entries(options.presets ?? {
    [SELF]: 'danger-full-access',
    [PEER]: 'workspace-write',
    [THIRD]: 'workspace-write',
  }));
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on: (name, handler) => { handlers.push(handler); return () => {}; },
    get: (key) => (key === 'workspaceRegistry'
      ? { list: () => [{ id: 'ws-a', path: 'C:\\work\\a', title: 'A' }] }
      : undefined),
    sessions: { get: (id) => live.get(id) },
    agents: { get: (id) => ({ status: options.status ?? 'idle', inbox: { nextTurn: [], nextStep: [] } }) },
    permissionPresets: options.permissionPresets ?? {
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
    // sessions above is the live-Session service; the raw rows live here.
    sessionRows: sessions,
    presetOf,
    handlers,
  };
  return ctx;
}

/** Mount and expose the registered tools by name. */
function mountWithTools(host, config = {}) {
  const registered = [];
  host.tools = { register: (definition) => { registered.push(definition); return () => {}; } };
  host.inject = (deps, callback) => { callback({ systemPrompt: { section: () => () => {} } }); };
  const bus = createSessionBus({
    ctx: host,
    config: { audit: false, persistState: false, spoolLongMessages: false, ...config },
    persist: false,
    clock: () => 1760000000000,
  });
  bus.attach(host);
  registerTools(host, bus);
  return { bus, tools: Object.fromEntries(registered.map((tool) => [tool.name, tool])) };
}

/** A tool execution context for one calling Session. */
function execFor(host, sessionId = SELF) {
  const row = host.sessionRows.find((item) => item.sessionId === sessionId);
  return {
    agent: { id: sessionId, session: { header: { cwd: row.cwd, agentPreset: 'standard' }, snapshotEvents: () => [] } },
    signal: new AbortController().signal,
    callId: 'call-1',
    rootCallId: 'call-1',
  };
}

// --- P0-1: the hop budget belongs to the conversation ----------------------

test('P0-1 a reply continues its thread, a different peer starts a new one', async () => {
  const host = createHost();
  const { bus } = mountWithTools(host, { maxHops: 3 });

  const first = await bus.send({ to: PEER, message: 'first', sender: senderA });
  assert.equal(first.hop, 1);
  const reply = await bus.send({ to: SELF, message: 'answer', sender: senderB });
  assert.equal(reply.hop, 2);
  assert.equal(reply.threadId, first.threadId);
  assert.equal(reply.replyTo, first.messageId);

  // The bug this replaces: the third Session used to inherit the hop count of a
  // conversation it is not part of.
  const third = await bus.send({ to: THIRD, message: 'unrelated task', sender: senderA });
  assert.equal(third.hop, 1);
  assert.notEqual(third.threadId, first.threadId);
  assert.equal(third.hopRemaining, 2);
});

test('P0-1 one exhausted conversation cannot block another', async () => {
  const host = createHost();
  const { bus } = mountWithTools(host, { maxHops: 2 });
  await bus.send({ to: PEER, message: 'one', sender: senderA });
  await bus.send({ to: SELF, message: 'two', sender: senderB });
  await assert.rejects(
    () => bus.send({ to: PEER, message: 'three', sender: senderA }),
    (error) => error.code === 'hop_budget_exhausted' && error.message.includes('hop 3'),
  );
  const unrelated = await bus.send({ to: THIRD, message: 'still fine', sender: senderA });
  assert.equal(unrelated.hop, 1);
});

test('P0-1 an explicit thread or reply_to pins the conversation', async () => {
  const host = createHost();
  const { bus } = mountWithTools(host, { maxHops: 8 });
  const first = await bus.send({ to: PEER, message: 'first', sender: senderA });
  // Naming the thread pins the conversation even when the message goes to a
  // third Session; a second message from the side that already holds the turn is
  // the same hand-off, so it does not spend a hop.
  const continued = await bus.send({ to: THIRD, message: 'cc', sender: senderA, threadId: first.threadId });
  assert.equal(continued.threadId, first.threadId);
  assert.equal(continued.hop, 1);
  // The hand-off costs the hop: the other side answering moves the thread on.
  const answered = await bus.send({ to: SELF, message: 'two', sender: senderB, threadId: first.threadId });
  assert.equal(answered.hop, 2);
  const pinned = await bus.send({ to: PEER, message: 're', sender: senderA, replyTo: first.messageId });
  assert.equal(pinned.threadId, first.threadId);
  assert.equal(pinned.hop, 3);
  assert.equal(pinned.replyTo, first.messageId);
});

test('P0-1 the ledger survives a Host restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'session-bus-state-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const first = createHost();
    const busA = createSessionBus({ ctx: first, config: { audit: false, spoolLongMessages: false }, clock: () => 1760000000000 });
    const sent = await busA.send({ to: PEER, message: 'first', sender: senderA });
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(existsSync(join(home, 'session-bus', 'state.json')), true);

    // A brand-new bus, as after a restart: the thread and its hop count are back.
    const second = createHost();
    const busB = createSessionBus({ ctx: second, config: { audit: false, spoolLongMessages: false }, clock: () => 1760000000000 });
    const threads = busB.threads({ sender: senderA });
    assert.equal(threads.total, 1);
    assert.equal(threads.threads[0].threadId, sent.threadId);
    const reply = await busB.send({ to: SELF, message: 'answer', sender: senderB });
    assert.equal(reply.hop, 2);
    assert.equal(reply.threadId, sent.threadId);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('P0-1 ThreadLedger keeps unrelated conversations apart', () => {
  const ledger = new ThreadLedger();
  const t1 = ledger.next({ senderId: SELF, targetId: PEER });
  ledger.record({ threadId: t1.threadId, hop: 1, messageId: 'm1', fromId: SELF, toId: PEER, at: 1 });
  const t2 = ledger.next({ senderId: PEER, targetId: SELF });
  ledger.record({ threadId: t2.threadId, hop: 2, messageId: 'm2', fromId: PEER, toId: SELF, at: 2 });
  assert.equal(t2.threadId, t1.threadId);
  const other = ledger.next({ senderId: SELF, targetId: THIRD });
  assert.equal(other.hop, 1);
  assert.notEqual(other.threadId, t1.threadId);
  // A thread exists once a message traveled on it, not when it was allocated.
  assert.equal(ledger.threadsOf(SELF).length, 1);
  ledger.record({ threadId: other.threadId, hop: 1, messageId: 'm3', fromId: SELF, toId: THIRD, at: 3 });
  assert.equal(ledger.threadsOf(SELF).length, 2);
});

// --- P0-2: correlation ------------------------------------------------------

test('P0-2 the envelope carries thread and re, and old headers still parse', async () => {
  const host = createHost();
  const { bus } = mountWithTools(host);
  const first = await bus.send({ to: PEER, message: 'first', sender: senderA });
  const reply = await bus.send({ to: SELF, message: 'answer', sender: senderB });
  const envelope = parseEnvelope(host.prompts[1].content[0].text);
  assert.equal(envelope.threadId, first.threadId);
  assert.equal(envelope.replyTo, first.messageId);
  assert.equal(envelope.from, PEER);
  assert.equal(reply.threadId, first.threadId);

  // A peer running an older version writes no thread/re at all.
  const legacy = '[session-bus v1] from=session-old hop=1/8 msg=zzz\nsent-at: 2026-01-01T00:00:00.000Z\n--- message ---\nhi\n--- reply ---\nbye\n';
  const parsed = parseEnvelope(legacy);
  assert.equal(parsed.from, 'session-old');
  assert.equal(parsed.messageId, 'zzz');
  assert.equal(parsed.hop, 1);
  assert.equal(parsed.threadId, undefined);
  assert.equal(parsed.body, 'hi');
});

test('P0-2 bus_threads reports what is still owed', async () => {
  const host = createHost();
  const { bus, tools } = mountWithTools(host);
  const sent = await bus.send({ to: PEER, message: 'please do X', sender: senderA });

  const pending = await tools.bus_threads.execute({}, execFor(host));
  assert.equal(pending.total, 1);
  assert.equal(pending.threads[0].threadId, sent.threadId);
  assert.equal(pending.threads[0].peer, PEER);
  assert.equal(pending.threads[0].pending, true);
  assert.equal(pending.threads[0].awaitingYou, false);
  assert.equal(pending.threads[0].lastMessageId, sent.messageId);

  await bus.send({ to: SELF, message: 'done', sender: senderB, threadId: sent.threadId });
  const answered = await tools.bus_threads.execute({}, execFor(host));
  assert.equal(answered.threads[0].pending, false);
  assert.equal(answered.threads[0].awaitingYou, true);

  // The peer's own view is the mirror image.
  const peerView = await tools.bus_threads.execute({}, execFor(host, PEER));
  assert.equal(peerView.threads[0].awaitingYou, false);
});

// --- P0-3: refusals are coded, audited and side-effect free -----------------

test('P0-3 every refusal is audited with a code and delivers nothing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'session-bus-audit-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const host = createHost();
    const { bus } = mountWithTools(host, { audit: true, maxHops: 1, maxMessageChars: 64, allowSpawn: false });

    const cases = [
      ['empty_message', () => bus.send({ to: PEER, message: '   ', sender: senderA })],
      ['message_too_long', () => bus.send({ to: PEER, message: 'x'.repeat(65), sender: senderA })],
      ['self_send_disabled', () => bus.send({ to: SELF, message: 'hi', sender: senderA })],
      ['no_sender', () => bus.send({ to: PEER, message: 'hi', sender: {} })],
      ['spawn_disabled', () => bus.spawn({ message: 'hi', sender: senderA })],
    ];
    for (const [code, run] of cases) {
      await assert.rejects(run, (error) => error.code === code, `expected ${code}`);
    }
    assert.equal(host.prompts.length, 0, 'a refusal must not deliver anything');

    // exhausted budget, after one real delivery
    await bus.send({ to: PEER, message: 'ok', sender: senderA });
    await assert.rejects(
      () => bus.send({ to: SELF, message: 'bounce', sender: senderB }),
      (error) => error.code === 'hop_budget_exhausted',
    );

    await bus.auditQueue;
    const records = readFileSync(join(home, 'session-bus', 'audit.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const rejects = records.filter((record) => record.event === 'reject');
    assert.deepEqual(
      cases.map(([code]) => code).filter((code) => !rejects.some((record) => record.code === code)),
      [],
    );
    assert.equal(rejects.some((record) => record.code === 'hop_budget_exhausted'), true);
    for (const record of rejects) {
      // A refusal names the Session it addressed; a refused spawn has none.
      assert.ok(record.to === null || typeof record.to === 'string', 'a reject record names its target');
    }
    assert.equal(records.filter((record) => record.event === 'deliver').length, 1);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('P0-3 a failed delivery undoes the permission it raised, and says so in the audit', async () => {
  const home = mkdtempSync(join(tmpdir(), 'session-bus-rollback-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const host = createHost();
    const { bus } = mountWithTools(host, { audit: true });
    host.sessionController.prompt = async () => { throw new Error('session/agent-busy: prompt rejected'); };
    await assert.rejects(
      () => bus.send({ to: PEER, message: 'hi', sender: senderA }),
      (error) => error.code === 'delivery_failed',
    );
    assert.equal(host.presetOf.get(PEER), 'workspace-write', 'the raise must be rolled back');
    assert.equal(bus.elevated.size, 0);

    // The rollback is only half the story: the audit has to name it, otherwise a
    // preset that moved and moved back is indistinguishable from one that never
    // moved — exactly the case an operator investigates later.
    await bus.auditQueue;
    const records = readFileSync(join(home, 'session-bus', 'audit.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const restored = records.filter((record) => record.event === 'permission_restore');
    assert.equal(restored.length, 1);
    assert.equal(restored[0].sessionId, PEER);
    assert.equal(restored[0].from, 'danger-full-access');
    assert.equal(restored[0].to, 'workspace-write');
    const rejects = records.filter((record) => record.event === 'reject');
    assert.equal(rejects.length, 1);
    assert.equal(rejects[0].code, 'delivery_failed');
    assert.equal(rejects[0].permissionRestored, true);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

// --- P1-2: overlapping workspaces and write scopes --------------------------

test('P1-2 write scopes reach the envelope and the audit, overlap is called out', async () => {
  const home = mkdtempSync(join(tmpdir(), 'session-bus-scope-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const host = createHost({
      sessions: [
        { sessionId: SELF, cwd: 'C:\\work\\a', updatedAt: 1000, running: false, agentAvailable: true, projections: { values: { title: 'A' } } },
        { sessionId: PEER, cwd: 'C:\\work\\a', updatedAt: 900, running: false, agentAvailable: true, projections: { values: { title: 'B' } } },
      ],
    });
    const { bus, tools } = mountWithTools(host, { audit: true });
    const receipt = await bus.send({
      to: PEER,
      message: 'take the views layer',
      sender: senderA,
      writeScopes: ['frontend/src/views', ' frontend/src/views '],
    });
    assert.equal(receipt.crossWorkspace, false);
    assert.match(receipt.note, /shares your working directory/);
    assert.match(receipt.note, /frontend\/src\/views/);

    const envelope = parseEnvelope(host.prompts[0].content[0].text);
    assert.deepEqual(envelope.writeScopes, ['frontend/src/views']);
    assert.match(host.prompts[0].content[0].text, /Write scope for this task/);

    await bus.auditQueue;
    const records = readFileSync(join(home, 'session-bus', 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    assert.deepEqual(records[0].writeScopes, ['frontend/src/views']);

    const listed = await tools.bus_list.execute({ query: 'B' }, execFor(host));
    assert.equal(listed.sessions[0].sameCwdAsCaller, true);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

// --- P2: spooling, idempotent spawn, incremental read ----------------------

test('P2 a body above the limit is spooled instead of refused', async () => {
  const home = mkdtempSync(join(tmpdir(), 'session-bus-spool-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const host = createHost();
    const { bus } = mountWithTools(host, { spoolLongMessages: true, maxMessageChars: 32 });
    const body = 'x'.repeat(200);
    const receipt = await bus.send({ to: PEER, message: body, sender: senderA });
    assert.equal(receipt.spooled, true);

    const envelope = parseEnvelope(host.prompts[0].content[0].text);
    assert.equal(typeof envelope.bodyFile, 'string');
    assert.equal(existsSync(envelope.bodyFile), true);
    assert.equal(readFileSync(envelope.bodyFile, 'utf8'), body);
    assert.equal(envelope.bodyBytes, 200);
    assert.match(envelope.body, /long message: 200 characters stored at/);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('P2 the same spawn key reuses one Session', async () => {
  const host = createHost();
  const { bus } = mountWithTools(host);
  const first = await bus.spawn({ message: 'start', sender: senderA, spawnKey: 'gys-batch-1' });
  assert.equal(first.created, true);
  const again = await bus.spawn({ message: 'start', sender: senderA, spawnKey: 'gys-batch-1' });
  assert.equal(again.created, false);
  assert.equal(again.sessionId, first.sessionId);
  assert.equal(host.created.length, 2, 'create is called, but it adopts the same identity');
  const other = await bus.spawn({ message: 'start', sender: senderA, spawnKey: 'gys-batch-2' });
  assert.notEqual(other.sessionId, first.sessionId);
});

test('P2 bus_read since returns only newer messages', async () => {
  const base = Date.parse('2026-05-05T10:00:00.000Z');
  const events = [
    { type: 'user/message', seq: 1, time: base, data: { role: 'user', content: [{ type: 'text', text: 'old request' }] } },
    { type: 'assistant/message', seq: 2, time: base + 1000, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] } } },
    { type: 'user/message', seq: 3, time: base + 2000, data: { role: 'user', content: [{ type: 'text', text: 'newer request' }] } },
  ];
  const host = createHost({ events });
  const { bus } = mountWithTools(host);
  // A bus message id resolves through the ledger; before that, an ISO timestamp.
  const incremental = await bus.read({
    session: PEER,
    sender: senderA,
    since: new Date(base + 500).toISOString(),
  });
  assert.deepEqual(incremental.messages.map((message) => message.text), ['old answer', 'newer request']);
  assert.equal(incremental.since, new Date(base + 500).toISOString());

  const all = await bus.read({ session: PEER, sender: senderA });
  assert.equal(all.returned, 3);
  assert.equal(all.since, null);
});

// --- P1-3: permission restore ----------------------------------------------

test('P1-3 a raised permission comes back when the delivered turn ends', async () => {
  const host = createHost();
  const { bus } = mountWithTools(host, { restorePermission: true });
  await bus.send({ to: PEER, message: 'do it', sender: senderA });
  assert.equal(host.presetOf.get(PEER), 'danger-full-access');
  assert.equal(bus.elevated.size, 1);

  // The Host reports the turn is over and the Session is idle.
  assert.equal(host.handlers.length, 1);
  host.handlers[0]({ id: PEER }, { type: 'turn/end' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(host.presetOf.get(PEER), 'workspace-write');
  assert.equal(bus.elevated.size, 0);
});

test('R3 a rollback that could not be written keeps the debt and pays it later', async () => {
  const host = createHost();
  const { bus } = mountWithTools(host, { restorePermission: true });
  await bus.send({ to: PEER, message: 'do it', sender: senderA });
  assert.equal(host.presetOf.get(PEER), 'danger-full-access');

  // The preset service fails for the rollback only: the raise already happened.
  const working = host.permissionPresets.set;
  host.permissionPresets.set = () => { throw new Error('permission service offline'); };
  host.sessionController.prompt = async () => { throw new Error('session/agent-busy: prompt rejected'); };
  await assert.rejects(
    () => bus.send({ to: PEER, message: 'again', sender: senderA }),
    (error) => error.code === 'delivery_failed' && error.details.permissionRestored === false,
  );
  assert.equal(host.presetOf.get(PEER), 'danger-full-access');
  assert.equal(bus.elevated.size, 1, 'an unwritten rollback must not drop the only record of the raise');

  // The service recovers and the Session is idle again: the debt is settled.
  host.permissionPresets.set = working;
  host.handlers[0]({ id: PEER }, { type: 'turn/end' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(host.presetOf.get(PEER), 'workspace-write');
  assert.equal(bus.elevated.size, 0);
});

test('P1-3 a user change during the turn is not undone', async () => {
  const host = createHost();
  const { bus } = mountWithTools(host, { restorePermission: true });
  await bus.send({ to: PEER, message: 'do it', sender: senderA });
  host.presetOf.set(PEER, 'read-only');
  host.handlers[0]({ id: PEER }, { type: 'turn/end' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(host.presetOf.get(PEER), 'read-only');
});

test('P1-3 a busy Session keeps the level it still needs', async () => {
  const host = createHost({ status: 'running' });
  const { bus } = mountWithTools(host, { restorePermission: true });
  await bus.send({ to: PEER, message: 'do it', sender: senderA });
  host.handlers[0]({ id: PEER }, { type: 'turn/end' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(host.presetOf.get(PEER), 'danger-full-access');
  assert.equal(bus.elevated.size, 1);
});

test('P1-3 restartorePermission=false leaves the raise in place', async () => {
  const host = createHost();
  const { bus } = mountWithTools(host, { restorePermission: false });
  await bus.send({ to: PEER, message: 'do it', sender: senderA });
  host.handlers[0]({ id: PEER }, { type: 'turn/end' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(host.presetOf.get(PEER), 'danger-full-access');
  assert.equal(bus.elevated.size, 0, 'the pending record is dropped, not left to fire later');
});

test('P1-3 elevate:false never touches the target', async () => {
  const host = createHost();
  const { bus } = mountWithTools(host);
  const receipt = await bus.send({ to: PEER, message: 'hi', sender: senderA, elevate: false });
  assert.equal(host.presetOf.get(PEER), 'workspace-write');
  assert.equal(receipt.permission, undefined);
  assert.equal(bus.elevated.size, 0);
});

// --- review round 2: follow-ups, id references, and the no-restart loop -----

test('R2-B a follow-up before the peer answers stays in the same thread, on the same hop', async () => {
  const host = createHost();
  const { bus, tools } = mountWithTools(host);
  const first = await bus.send({ to: PEER, message: 'long task body', sender: senderA });
  const second = await bus.send({ to: PEER, message: '补充：还有一个细节', sender: senderA });

  assert.equal(second.threadId, first.threadId, 'the follow-up must not open a parallel thread');
  assert.equal(second.replyTo, first.messageId, 'the follow-up answers the message it continues');
  assert.equal(second.hop, 1, 'the side that already holds the turn does not spend a hop again');

  const view = await tools.bus_threads.execute({}, execFor(host));
  assert.equal(view.threads.length, 1, 'no thread is left stranded pending');
  assert.equal(view.threads[0].pending, true);
  assert.equal(view.threads[0].lastMessageId, second.messageId);

  // The answer is the hand-off: that is what costs a hop, so a real bounce is
  // still cut off by maxHops.
  const answer = await bus.send({ to: SELF, message: 'done', sender: senderB });
  assert.equal(answer.threadId, first.threadId);
  assert.equal(answer.hop, 2);
  assert.equal(answer.replyTo, second.messageId);
});

test('R2-B an unrelated peer still gets its own thread while one is pending', async () => {
  const senderC = { id: THIRD, title: 'C', cwd: 'C:\\work\\c' };
  const host = createHost();
  const { bus, tools } = mountWithTools(host);
  const withPeer = await bus.send({ to: PEER, message: 'for B', sender: senderA });
  const withThird = await bus.send({ to: THIRD, message: 'for C', sender: senderA });
  assert.notEqual(withThird.threadId, withPeer.threadId);
  assert.equal(withThird.hop, 1, 'an unrelated peer never inherits a running conversation');
  assert.equal(withThird.replyTo, undefined);

  // C answers, then A writes to C again: that stays C's conversation.
  const answeredC = await bus.send({ to: SELF, message: 'done C', sender: senderC });
  assert.equal(answeredC.threadId, withThird.threadId);
  assert.equal(answeredC.hop, 2);
  const moreC = await bus.send({ to: THIRD, message: 'one more', sender: senderA });
  assert.equal(moreC.threadId, withThird.threadId);
  assert.equal(moreC.hop, 3, 'C answered in between, so this is a fresh hand-off');
  assert.equal(moreC.replyTo, answeredC.messageId);

  // B's conversation is exactly where it was left.
  const view = await tools.bus_threads.execute({}, execFor(host));
  const forB = view.threads.find((thread) => thread.threadId === withPeer.threadId);
  assert.equal(forB.hop, 1);
  assert.equal(forB.pending, true);
});

test('R2-A an inbound message id resolves as `since`, exactly like one the caller sent', async () => {
  const host = createHost();
  const { bus } = mountWithTools(host);
  const mine = await bus.send({ to: PEER, message: 'ping', sender: senderA });
  // B answers: this id only ever appears in an envelope the caller *received*.
  const theirs = await bus.send({ to: SELF, message: 'pong', sender: senderB });

  const delta = await bus.read({ session: PEER, sender: senderA, since: theirs.messageId });
  assert.equal(delta.since, new Date(1760000000000).toISOString());
  const full = await bus.read({ session: PEER, sender: senderA, since: mine.messageId });
  assert.equal(full.since, new Date(1760000000000).toISOString());

  // A date and an epoch still work; nonsense is still a coded refusal.
  await bus.read({ session: PEER, sender: senderA, since: '2026-01-01T00:00:00.000Z' });
  await bus.read({ session: PEER, sender: senderA, since: 1760000000000 });
  await assert.rejects(
    () => bus.read({ session: PEER, sender: senderA, since: 'not-a-date' }),
    (error) => error.code === 'invalid_since',
  );
});

test('R2-A an inbox id survives pruning of the message table', () => {
  const ledger = new ThreadLedger();
  // The first message becomes the oldest entry, so pruning drops it first — but
  // its inbox row is what the peer still quotes in `re=`.
  ledger.record({ threadId: 't-keep', hop: 1, messageId: 'm-keep', fromId: SELF, toId: PEER, at: 1 });
  for (let index = 0; index < 1200; index += 1) {
    ledger.record({ threadId: `t-${index}`, hop: 1, messageId: `m-${index}`, fromId: SELF, toId: THIRD, at: 10 + index });
  }
  assert.equal(ledger.message('m-keep')?.threadId, 't-keep', 'the inbox keeps the id the message table pruned');
  assert.equal(ledger.message('m-nope'), undefined);
});
