import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionBus } from '../lib/bus.js';
import { parseEnvelope } from '../lib/envelope.js';

const CLOCK = 1760000000000;
const MAIN = { id: 'session-main0001', title: 'Main', cwd: 'C:\\work\\a' };
const BUSY = 'session-busy0002';
const WORKDIR = 'C:\\work\\a';

/**
 * Host double with rows, live Agents, and Session creation.
 *
 * The busy row is the interesting one: `running: true` plus an Agent whose
 * status is `'running'` is what `whenBusy: "spawn"` looks at. Created worker
 * Sessions get their own idle Agent so the bus can deliver the first message.
 * @param {object} [options] - host tweaks (`status` overrides the busy Agent's).
 * @returns {object} the host double.
 */
function createHost(options = {}) {
  const sessions = [
    { sessionId: MAIN.id, cwd: WORKDIR, updatedAt: CLOCK, running: false, agentAvailable: true, projections: { values: { title: MAIN.title } } },
    { sessionId: BUSY, cwd: WORKDIR, updatedAt: CLOCK - 1000, running: options.busyRunning ?? true, agentAvailable: true, projections: { values: { title: 'Busy module' } } },
  ];
  const boxes = new Map();
  const agents = new Map();
  const created = [];
  const renames = [];
  const prompts = [];

  const addAgent = (sessionId, status) => {
    const box = { nextTurn: [], nextStep: [] };
    boxes.set(sessionId, box);
    agents.set(sessionId, {
      id: sessionId,
      status,
      inbox: box,
      session: { id: sessionId, snapshotEvents: () => [], flush: () => {} },
      followup(message) { box.nextTurn.push(message); },
      steer(message) { box.nextStep.push(message); },
      inject(message) { box.nextTurn.push(message); },
    });
  };
  addAgent(MAIN.id, 'idle');
  addAgent(BUSY, options.status ?? 'running');

  const host = {
    created,
    renames,
    prompts,
    sessions,
    inboxOf: (sessionId) => boxes.get(sessionId),
    sessionsService: { flush: async () => true, get: () => undefined },
    sessionController: {
      async list() { return { items: sessions }; },
      async inspect() { return { meta: {}, inheritedEventCount: 0, events: [] }; },
      async prompt(request) { prompts.push(request); return { accepted: true }; },
      async resolveAgent(sessionId) {
        const agent = agents.get(sessionId);
        return agent === undefined ? { error: new Error(`unknown Session ${sessionId}`) } : { agent };
      },
      async create(request) {
        created.push(request);
        const sessionId = request.sessionId ?? `session-worker${String(created.length).padStart(3, '0')}`;
        sessions.push({ sessionId, cwd: request.cwd ?? WORKDIR, updatedAt: CLOCK, running: false, agentAvailable: true });
        addAgent(sessionId, 'idle');
        return { sessionId };
      },
      async rename(request) { renames.push(request); return { title: request.title, seq: 1 }; },
    },
    get(name) {
      if (name === 'sessions') return host.sessionsService;
      if (name !== 'workspaceRegistry') return undefined;
      return { list: () => [{ id: 'ws-a', path: WORKDIR, title: 'A' }] };
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
    persist: false,
    clock: () => CLOCK,
    idFactory: () => `msg${String(++counter).padStart(9, '0')}`,
  });
}

test('whenBusy: spawn hands a task to a fresh worker instead of queueing on a busy target', async () => {
  const host = createHost();
  const bus = createBus(host);
  const receipt = await bus.send({
    to: 'Busy module',
    message: 'fix the failing test',
    kind: 'task',
    whenBusy: 'spawn',
    sender: MAIN,
  });

  assert.equal(receipt.delivered, true);
  assert.equal(receipt.whenBusy, 'spawn');
  assert.equal(receipt.handedOffFrom.sessionId, BUSY);
  assert.equal(receipt.worker.preset, 'dev-session');
  assert.equal(receipt.sessionId, receipt.worker.sessionId);

  // One worker Session, started with the development preset in the same workspace.
  assert.equal(host.created.length, 1);
  assert.equal(host.created[0].agentPreset, 'dev-session');
  assert.equal(host.created[0].workspaceId, 'ws-a');

  // Registered as a dev worker so the workspace progress chip counts it.
  const record = bus.roleRegistry.get(receipt.sessionId);
  assert.equal(record.role, 'dev');
  assert.equal(record.worker, true);

  // The brief names the dispatcher, carries the task, and asks for a closed conclusion.
  const box = host.inboxOf(receipt.sessionId);
  assert.equal(box.nextTurn.length, 1);
  assert.equal(box.nextStep.length, 0);
  const envelope = parseEnvelope(box.nextTurn[0].content[0].text);
  assert.match(envelope.body, /fix the failing test/);
  assert.match(envelope.body, /session-main0001/);
  assert.match(envelope.body, /conclusion/);

  // The busy target is untouched: it keeps finishing its own turn.
  assert.equal(host.inboxOf(BUSY).nextTurn.length, 0);
  assert.equal(host.inboxOf(BUSY).nextStep.length, 0);
  assert.equal(host.prompts.length, 0);
});

test('whenBusy: spawn delivers to the target itself when it is idle', async () => {
  const host = createHost({ busyRunning: false, status: 'idle' });
  const bus = createBus(host);
  const receipt = await bus.send({
    to: 'Busy module',
    message: 'just do it now',
    whenBusy: 'spawn',
    sender: MAIN,
  });

  assert.equal(host.created.length, 0);
  assert.equal(receipt.sessionId, BUSY);
  assert.equal(receipt.whenBusy, undefined);
  assert.equal(host.inboxOf(BUSY).nextTurn.length, 1);
});

test('without whenBusy a busy target still queues the message', async () => {
  const host = createHost();
  const bus = createBus(host);
  const receipt = await bus.send({ to: 'Busy module', message: 'take your time', sender: MAIN });

  assert.equal(host.created.length, 0);
  assert.equal(receipt.sessionId, BUSY);
  assert.equal(host.inboxOf(BUSY).nextTurn.length, 1);
  assert.match(receipt.note, /running a turn/);
});

test('the worker limit falls back to queueing instead of spawning another worker', async () => {
  const host = createHost();
  const bus = createBus(host, { maxWorkers: 1 });
  bus.roleRegistry.set({
    sessionId: 'session-existing-worker',
    role: 'dev',
    module: 'existing',
    cwd: WORKDIR,
    workspace: WORKDIR,
    worker: true,
  });

  const receipt = await bus.send({
    to: 'Busy module',
    message: 'one more task',
    kind: 'task',
    whenBusy: 'spawn',
    sender: MAIN,
  });

  assert.equal(host.created.length, 0);
  assert.equal(receipt.whenBusy, 'queue');
  assert.equal(receipt.sessionId, BUSY);
  assert.match(receipt.note, /worker limit/i);
  assert.equal(host.inboxOf(BUSY).nextTurn.length, 1);
});

test('whenBusy: spawn refuses when spawning is disabled', async () => {
  const host = createHost();
  const bus = createBus(host, { allowSpawn: false });
  await assert.rejects(
    () => bus.send({ to: 'Busy module', message: 'parallel please', whenBusy: 'spawn', sender: MAIN }),
    /spawn_disabled/,
  );
  assert.equal(host.created.length, 0);
});
