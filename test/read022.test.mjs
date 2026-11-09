import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { SessionBus } from '../lib/bus.js';

const CLOCK = 1760000000000;

/**
 * Build a Host double that speaks the DSH 0.2.2 `sessionController` shape:
 * `list`/`create`/`prompt` plus `events`, and deliberately no `inspect`.
 * @param {{reader?: 'events'|'inspect'|'none', events?: object[], hasMore?: boolean, reject?: string[]}} options - Host capabilities.
 * @returns {object} the Host double.
 */
function createHost(options = {}) {
  const sessions = [
    { sessionId: 'session-main0001', cwd: 'C:\\work\\a', updatedAt: CLOCK, running: false, agentAvailable: true },
    { sessionId: 'session-other002', cwd: 'C:\\work\\b', updatedAt: CLOCK - 1000, running: false, agentAvailable: true },
  ];
  const events = options.events ?? [];
  const reject = new Set(options.reject ?? []);
  const created = [];
  const host = {
    sessions,
    created,
    sessionController: {
      async list() {
        return { items: sessions };
      },
      async prompt() {
        return { accepted: true };
      },
      async create(request) {
        created.push(request);
        const sessionId = typeof request.sessionId === 'string' ? request.sessionId : 'session-spawn001';
        if (!sessions.some((row) => row.sessionId === sessionId)) {
          sessions.push({ sessionId, cwd: request.cwd ?? 'C:\\work\\a', updatedAt: CLOCK, running: false, agentAvailable: true });
        }
        return { sessionId };
      },
    },
    get(name) {
      if (name !== 'workspaceRegistry') return undefined;
      return { list: () => [{ id: 'ws-a', path: 'C:\\work\\a', title: 'Workspace A' }] };
    },
  };
  if (options.reader === 'events') {
    host.sessionController.events = async (request) => {
      const sessionId = request?.address?.sessionId;
      if (options.rejectAll === true || reject.has(sessionId)) throw new Error('session/not-found');
      return {
        records: events.map((event) => ({ type: 'event', event })),
        hasMore: options.hasMore === true,
        cursor: events.length,
      };
    };
  }
  if (options.reader === 'inspect') {
    host.sessionController.inspect = async (sessionId) => {
      if (reject.has(sessionId)) throw new Error('session/not-found');
      return { events };
    };
  }
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

const senderA = { id: 'session-main0001', title: 'Main', cwd: 'C:\\work\\a' };

/** Two messages plus a title event, as a Session log would record them. */
const transcript = [
  { type: 'session/title', seq: 1, time: CLOCK - 3000, data: { title: 'Greeter' } },
  { type: 'user/message', seq: 2, time: CLOCK - 2000, data: { content: [{ type: 'text', text: 'hello there' }] } },
  { type: 'assistant/message', seq: 3, time: CLOCK - 1000, data: { message: { content: [{ type: 'text', text: 'hi, how can I help?' }] } } },
];

test('read uses the 0.2.2 events page when the Host has no inspect', async () => {
  const host = createHost({ reader: 'events', events: transcript });
  const bus = createBus(host);
  const result = await bus.read({ session: 'session-main0001', sender: senderA });

  assert.equal(result.sessionId, 'session-main0001');
  assert.equal(result.title, 'Greeter');
  assert.equal(result.totalEvents, 3);
  assert.equal(result.returned, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.messages.map((message) => message.role), ['user', 'assistant']);
  assert.equal(result.messages[0].text, 'hello there');
  assert.equal(result.messages[1].text, 'hi, how can I help?');
  assert.equal(result.messages[0].viaBus, false);
});

test('read degrades to an explanatory note when no transcript reader exists', async () => {
  const host = createHost({ reader: 'none' });
  const bus = createBus(host);
  const result = await bus.read({ session: 'session-main0001', sender: senderA });

  assert.equal(result.returned, 0);
  assert.equal(result.totalEvents, 0);
  assert.deepEqual(result.messages, []);
  assert.match(result.note, /transcript reader/);
});

test('read still works on a Host that only has inspect (0.2.1 line)', async () => {
  const host = createHost({ reader: 'inspect', events: transcript });
  const bus = createBus(host);
  const result = await bus.read({ session: 'session-main0001', sender: senderA });

  assert.equal(result.returned, 2);
  assert.equal(result.title, 'Greeter');
});

test('a page with older messages left marks the read as truncated', async () => {
  const host = createHost({ reader: 'events', events: transcript, hasMore: true });
  const bus = createBus(host);
  const result = await bus.read({ session: 'session-main0001', sender: senderA });

  assert.equal(result.truncated, true);
});

test('spawn adopts the Session a retried key already created', async () => {
  const spawnKey = 'retry-me';
  const existingId = `session-bus-${createHash('sha256').update(spawnKey).digest('hex').slice(0, 20)}`;
  const host = createHost({ reader: 'events', events: [] });
  host.sessions.push({ sessionId: existingId, cwd: 'C:\\work\\a', updatedAt: CLOCK, running: false, agentAvailable: true });
  const bus = createBus(host);

  const receipt = await bus.spawn({ message: 'retry the same task', cwd: 'C:\\work\\a', sender: senderA, spawnKey });

  assert.equal(receipt.sessionId, existingId);
  assert.equal(receipt.created, false);
  // The Host reuses the named blank Session, so `create` is still called once —
  // with the adopted id, never with a fresh one.
  assert.equal(host.created.length, 1);
  assert.equal(host.created[0].sessionId, existingId);
});

test('spawn creates a new Session when the probe reports it missing', async () => {
  const host = createHost({ reader: 'events', events: [], rejectAll: true });
  const bus = createBus(host);

  const receipt = await bus.spawn({ message: 'fresh task', cwd: 'C:\\work\\a', sender: senderA, spawnKey: 'fresh-key' });

  assert.equal(receipt.created, true);
  assert.equal(host.created.length, 1);
});
