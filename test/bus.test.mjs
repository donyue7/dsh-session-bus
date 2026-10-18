import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionBus } from '../lib/bus.js';
import { parseEnvelope } from '../lib/envelope.js';

const CLOCK = 1760000000000;

/** Minimal Host double: only the services the bus is allowed to touch. */
function createHost(options = {}) {
  const sessions = options.sessions ?? [
    { sessionId: 'session-main0001', cwd: 'C:\\work\\a', updatedAt: CLOCK, running: false, agentAvailable: true, projections: { values: { title: 'Main' } } },
    { sessionId: 'session-other002', cwd: 'C:\\work\\b', updatedAt: CLOCK - 1000, running: true, agentAvailable: true, projections: { values: { title: 'Other workspace' } } },
    { sessionId: 'session-child03', cwd: 'C:\\work\\a', updatedAt: CLOCK - 2000, origin: 'subagent', projections: { values: {} } },
  ];
  const events = options.events ?? [];
  const delivered = [];
  const created = [];
  const host = {
    delivered,
    created,
    sessions,
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
        const sessionId = 'session-spawn001';
        sessions.push({ sessionId, cwd: request.cwd ?? 'C:\\work\\a', updatedAt: CLOCK, running: false, agentAvailable: true });
        return { sessionId };
      },
      async inspect() {
        return { meta: { id: 'session-main0001', cwd: 'C:\\work\\a' }, inheritedEventCount: 0, events };
      },
    },
    get(name) {
      if (name !== 'workspaceRegistry') return undefined;
      return {
        list: () => options.workspaces ?? [
          { id: 'ws-a', path: 'C:\\work\\a', title: 'Workspace A' },
          { id: 'ws-b', path: 'C:\\work\\b', title: 'Workspace B' },
        ],
      };
    },
  };
  return host;
}

/** Build a bus over a Host double. */
function createBus(host, config = {}) {
  let counter = 0;
  return new SessionBus({
    ctx: host,
    config: { audit: false, persistState: false, spoolLongMessages: false, ...config },
    // The core switch is the constructor option, not the `persistState` config
    // key: a test must never be able to write a ledger into a real DSH_HOME.
    persist: false,
    clock: () => CLOCK,
    idFactory: () => `msg${String(++counter).padStart(9, '0')}`,
  });
}

const senderA = { id: 'session-main0001', title: 'Main', cwd: 'C:\\work\\a' };
const senderB = { id: 'session-other002', title: 'Other workspace', cwd: 'C:\\work\\b' };

test('send admits one user message into the resolved Session', async () => {
  const host = createHost();
  const bus = createBus(host);
  const receipt = await bus.send({ to: 'session-other002', message: 'run the suite', sender: senderA });

  assert.equal(receipt.delivered, true);
  assert.equal(receipt.sessionId, 'session-other002');
  assert.equal(receipt.mode, 'queue');
  assert.equal(receipt.hop, 1);
  assert.equal(receipt.targetRunning, true);
  assert.equal(receipt.crossWorkspace, true);
  assert.match(receipt.note, /queued/);

  assert.equal(host.delivered.length, 1);
  const request = host.delivered[0];
  assert.equal(request.sessionId, 'session-other002');
  assert.equal(request.mode, 'queue');
  assert.equal(request.requestId, 'session-bus:msg000000001');
  assert.equal(request.content.length, 1);
  assert.equal(request.content[0].type, 'text');
  const envelope = parseEnvelope(request.content[0].text);
  assert.equal(envelope.from, 'session-main0001');
  assert.equal(envelope.hop, 1);
  assert.equal(envelope.body, 'run the suite');
});

test('an idle target is reported as started, and mode can be overridden', async () => {
  const host = createHost();
  const bus = createBus(host);
  const receipt = await bus.send({ to: 'Main', message: 'ping', mode: 'steer', sender: senderB });
  assert.equal(receipt.sessionId, 'session-main0001');
  assert.equal(receipt.mode, 'steer');
  assert.match(receipt.note, /resumed/);
  assert.equal(host.delivered[0].mode, 'steer');
});

test('hop depth grows across a reply so a bounce is bounded', async () => {
  const host = createHost();
  const bus = createBus(host, { maxHops: 2 });
  await bus.send({ to: 'session-other002', message: 'first', sender: senderA });
  const reply = await bus.send({ to: 'session-main0001', message: 'answer', sender: senderB });
  assert.equal(reply.hop, 2);
  await assert.rejects(
    () => bus.send({ to: 'session-other002', message: 'and again', sender: senderA }),
    /\[hop_budget_exhausted\]/,
  );
});

test('force delivers past the hop budget without resetting the count', async () => {
  const host = createHost();
  const bus = createBus(host, { maxHops: 1 });
  await bus.send({ to: 'session-other002', message: 'first', sender: senderA });
  await assert.rejects(
    () => bus.send({ to: 'session-main0001', message: 'bounce', sender: senderB }),
    /\[hop_budget_exhausted\]/,
  );
  // orce is a deliberate override, not a counter reset: the reported hop
  // stays honest so the next message is not silently back at 1.
  const forced = await bus.send({ to: 'session-main0001', message: 'bounce', force: true, sender: senderB });
  assert.equal(forced.hop, 2);
  assert.equal(forced.hopRemaining, 0);
});

test('sending to the calling Session is refused by default', async () => {
  const host = createHost();
  const bus = createBus(host);
  await assert.rejects(() => bus.send({ to: 'self', message: 'note to self', sender: senderA }), /own Session/);
  assert.equal(host.delivered.length, 0);
});

test('cross-workspace delivery can be refused by policy', async () => {
  const host = createHost();
  const bus = createBus(host, { allowCrossWorkspace: false });
  await assert.rejects(
    () => bus.send({ to: 'session-other002', message: 'hi', sender: senderA }),
    /cross-workspace delivery is disabled/,
  );
  const sameWorkspace = await bus.send({ to: 'session-main0001', message: 'hi', sender: { ...senderA, id: 'session-x' } });
  assert.equal(sameWorkspace.crossWorkspace, false);
});

test('oversized and empty messages are refused before delivery', async () => {
  const host = createHost();
  const bus = createBus(host, { maxMessageChars: 16 });
  await assert.rejects(() => bus.send({ to: 'session-other002', message: 'x'.repeat(17), sender: senderA }), /above the configured limit/);
  await assert.rejects(() => bus.send({ to: 'session-other002', message: '   ', sender: senderA }), /non-whitespace/);
  assert.equal(host.delivered.length, 0);
});

test('a subagent Session cannot be addressed', async () => {
  const host = createHost();
  const bus = createBus(host);
  await assert.rejects(() => bus.send({ to: 'session-child03', message: 'hi', sender: senderA }), /subagent/);
});

test('an ambiguous title is refused with candidates', async () => {
  const host = createHost({
    sessions: [
      { sessionId: 'session-main0001', cwd: 'C:\\work\\a', updatedAt: CLOCK, projections: { values: { title: 'Same' } } },
      { sessionId: 'session-other002', cwd: 'C:\\work\\b', updatedAt: CLOCK, projections: { values: { title: 'Same' } } },
    ],
  });
  const bus = createBus(host);
  await assert.rejects(() => bus.send({ to: 'Same', message: 'hi', sender: senderA }), /matches 2 Sessions/);
});

test('spawn uses a registered workspace and starts the new Session', async () => {
  const host = createHost();
  const bus = createBus(host);
  const receipt = await bus.spawn({ message: 'start here', workspace: 'Workspace B', sender: senderA });
  assert.equal(receipt.created, true);
  assert.equal(receipt.sessionId, 'session-spawn001');
  assert.deepEqual(host.created[0], { workspaceId: 'ws-b' });
  assert.equal(host.delivered.length, 1);
  assert.equal(host.delivered[0].sessionId, 'session-spawn001');
});

test('spawn falls back to the caller workspace and can be disabled', async () => {
  const host = createHost();
  const bus = createBus(host);
  const receipt = await bus.spawn({ message: 'start here', sender: senderA });
  assert.deepEqual(host.created[0], { workspaceId: 'ws-a' });
  assert.equal(receipt.cwd, 'C:\\work\\a');

  const disabled = createBus(createHost(), { allowSpawn: false });
  await assert.rejects(() => disabled.spawn({ message: 'x', sender: senderA }), /bus_spawn is disabled/);
});

test('read returns the transcript tail and marks bus messages', async () => {
  const envelope = [
    '[session-bus v1] from=session-main0001 hop=1/8 msg=abcdef123456',
    'from-title: Main',
    'from-cwd: C:\\work\\a',
    'sent-at: 2026-10-16T05:10:04.000Z',
    '--- message ---',
    'please run the suite',
    '--- reply ---',
    'answer with bus_send',
  ].join('\n');
  const host = createHost({
    events: [
      { type: 'turn/start', seq: 1, time: CLOCK, data: { turn: 1 } },
      { type: 'user/message', seq: 2, time: CLOCK, data: { role: 'user', content: [{ type: 'text', text: envelope }] } },
      { type: 'assistant/message', seq: 3, time: CLOCK + 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'all green' }] } } },
      { type: 'session/title', seq: 4, time: CLOCK + 2, data: { title: 'Suite run' } },
    ],
  });
  const bus = createBus(host);
  const result = await bus.read({ session: 'session-main0001', sender: senderA });
  assert.equal(result.sessionId, 'session-main0001');
  assert.equal(result.title, 'Suite run');
  assert.equal(result.returned, 2);
  assert.equal(result.messages[0].role, 'user');
  assert.equal(result.messages[0].viaBus, true);
  assert.equal(result.messages[0].text, envelope);
  assert.equal(result.messages[1].role, 'assistant');
  assert.equal(result.messages[1].text, 'all green');
  assert.equal(result.messages[1].viaBus, false);
  assert.equal(host.delivered.length, 0);
});

test('list hides subagents by default and can include them', async () => {
  const host = createHost();
  const bus = createBus(host);
  const visible = await bus.list({ selfId: 'session-main0001' });
  assert.equal(visible.total, 2);
  assert.equal(visible.sessions[0].isSelf, true);
  const all = await bus.list({ includeSubagents: true });
  assert.equal(all.total, 3);
  assert.equal(all.sessions.some((row) => row.isSubagent), true);
  const filtered = await bus.list({ query: 'other workspace' });
  assert.equal(filtered.sessions.length, 1);
  assert.equal(filtered.sessions[0].sessionId, 'session-other002');
});

test('delivery failures surface as one readable error', async () => {
  const host = createHost();
  host.sessionController.prompt = async () => {
    throw new Error('session/agent-busy: prompt rejected');
  };
  const bus = createBus(host);
  await assert.rejects(
    () => bus.send({ to: 'session-other002', message: 'hi', sender: senderA }),
    /delivery to "session-other002" failed: session\/agent-busy/,
  );
});

test('a pushed message needs a sending Session', async () => {
  const host = createHost();
  const bus = createBus(host);
  await assert.rejects(() => bus.send({ to: 'session-other002', message: 'hi', sender: {} }), /calling Session/);
});
