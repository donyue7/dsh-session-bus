import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionBus } from '../lib/bus.js';
import { parseEnvelope, renderEnvelope } from '../lib/envelope.js';

const CLOCK = 1760000000000;

const senderA = { id: 'session-main0001', title: 'Main', cwd: 'C:\\work\\a' };

/**
 * Host double with both delivery APIs: the Agent API that the notice
 * presentation uses, and the legacy prompt RPC. Tests assert which one a
 * delivery went through.
 */
function createHost(options = {}) {
  const sessions = [
    { sessionId: 'session-main0001', cwd: 'C:\\work\\a', updatedAt: CLOCK, running: false, agentAvailable: true, projections: { values: { title: 'Main' } } },
    { sessionId: 'session-other002', cwd: 'C:\\work\\b', updatedAt: CLOCK - 1000, running: true, agentAvailable: true, projections: { values: { title: 'Other' } } },
  ];
  const prompts = [];
  const resolved = [];
  const flushes = [];
  const log = [];
  const inbox = { nextTurn: [], nextStep: [] };
  const agent = {
    id: 'session-other002',
    status: 'idle',
    inbox,
    session: { id: 'session-other002', snapshotEvents: () => log.slice(), flush: () => {} },
    followup(message) { inbox.nextTurn.push(message); },
    steer(message) { inbox.nextStep.push(message); },
  };
  const host = {
    prompts,
    resolved,
    flushes,
    log,
    inbox,
    agent,
    sessions,
    sessionsService: { flush: async (session) => { flushes.push(session); return true; }, get: () => undefined },
    sessionController: {
      async list() { return { items: sessions }; },
      async inspect() { return { meta: { id: 'session-other002' }, inheritedEventCount: 0, events: [] }; },
      async prompt(request) { prompts.push(request); return { accepted: true }; },
      async resolveAgent(sessionId) { resolved.push(sessionId); return { agent }; },
    },
    get(name) {
      if (name === 'sessions') return host.sessionsService;
      if (name !== 'workspaceRegistry') return undefined;
      return { list: () => [{ id: 'ws-a', path: 'C:\\work\\a' }, { id: 'ws-b', path: 'C:\\work\\b' }] };
    },
  };
  if (options.agentError !== undefined) {
    host.sessionController.resolveAgent = async () => ({ error: new Error(options.agentError) });
  }
  if (options.noResolveAgent === true) delete host.sessionController.resolveAgent;
  if (options.noSessionsService === true) host.sessionsService = undefined;
  return host;
}

/** Build a bus over a Host double. */
function createBus(host, config = {}, logger) {
  let counter = 0;
  return new SessionBus({
    ctx: host,
    config: { audit: false, persistState: false, spoolLongMessages: false, ...config },
    persist: false,
    clock: () => CLOCK,
    idFactory: () => `msg${String(++counter).padStart(9, '0')}`,
    ...logger === undefined ? {} : { logger },
  });
}

/**
 * Teach a Host double to create Sessions and record renamed titles.
 * @param {object} host - host built by {@link createHost}.
 * @returns {object} the same host, extended.
 */
function withSpawn(host) {
  host.created = [];
  host.renames = [];
  host.sessionController.create = async (request) => {
    host.created.push(request);
    const sessionId = request.sessionId ?? 'session-spawn001';
    host.sessions.push({ sessionId, cwd: request.cwd ?? 'C:\\work\\a', updatedAt: CLOCK, running: false, agentAvailable: true });
    return { sessionId };
  };
  host.sessionController.rename = async (request) => {
    host.renames.push(request);
    return { title: request.title, seq: 1 };
  };
  return host;
}


test('the default presentation delivers an agent-message, not a user prompt', async () => {
  const host = createHost();
  const bus = createBus(host);
  const receipt = await bus.send({ to: 'Other', message: 'run the suite', sender: senderA });

  assert.equal(receipt.delivered, true);
  assert.equal(receipt.sessionId, 'session-other002');
  // Not the prompt RPC: the receiving UI must not see a locally typed bubble.
  assert.equal(host.prompts.length, 0);
  assert.deepEqual(host.resolved, ['session-other002']);

  assert.equal(host.inbox.nextTurn.length, 1);
  assert.equal(host.inbox.nextStep.length, 0);
  const message = host.inbox.nextTurn[0];
  assert.equal(message.role, 'user');
  assert.equal(typeof message.id, 'string');
  assert.equal(Object.isFrozen(message), true);
  assert.equal(Object.isFrozen(message.content), true);
  assert.equal(Object.isFrozen(message.source), true);

  // The source is what DSH's Chat renders as a non-human "agent message".
  assert.equal(message.source.kind, 'agent-message');
  assert.equal(message.source.form, 'relay');
  assert.equal(message.source.senderSessionId, 'session-main0001');
  assert.equal(message.source.busMessageId, receipt.messageId);
  assert.equal(message.source.threadId, receipt.threadId);
  assert.equal(message.source.hop, 1);

  const envelope = parseEnvelope(message.content[0].text);
  assert.equal(envelope.from, 'session-main0001');
  assert.equal(envelope.body, 'run the suite');

  // The inbox splice is durable: the target Session was flushed once.
  assert.deepEqual(host.flushes, [host.agent.session]);
});

test('steer mode submits into the running step through the Agent API', async () => {
  const host = createHost();
  const bus = createBus(host);
  await bus.send({ to: 'Other', message: 'focus on tests', mode: 'steer', sender: senderA });

  assert.equal(host.prompts.length, 0);
  assert.equal(host.inbox.nextStep.length, 1);
  assert.equal(host.inbox.nextTurn.length, 0);
  assert.equal(host.inbox.nextStep[0].source.kind, 'agent-message');
});

test('a retried delivery is recognised in the target log and not posted twice', async () => {
  const host = createHost();
  // The first attempt already landed but its caller never saw the answer.
  host.log.push({
    type: 'user/message',
    data: {
      role: 'user',
      content: [{ type: 'text', text: '(already delivered)' }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: senderA.id, busMessageId: 'msg000000001' },
    },
  });
  const bus = createBus(host);
  const receipt = await bus.send({ to: 'Other', message: 'run the suite', sender: senderA });

  assert.equal(receipt.delivered, true);
  assert.equal(receipt.messageId, 'msg000000001');
  assert.equal(host.inbox.nextTurn.length, 0);
  assert.equal(host.flushes.length, 0);
  assert.equal(host.prompts.length, 0);
});

test('a message still waiting in the inbox also counts as already admitted', async () => {
  const host = createHost();
  host.inbox.nextTurn.push({ role: 'user', content: [], source: { busMessageId: 'msg000000001' } });
  const bus = createBus(host);
  await bus.send({ to: 'Other', message: 'run the suite', sender: senderA });
  assert.equal(host.inbox.nextTurn.length, 1);
  assert.equal(host.flushes.length, 0);
});

test('inboundPresentation "bubble" keeps the legacy prompt path', async () => {
  const host = createHost();
  const bus = createBus(host, { inboundPresentation: 'bubble' });
  const receipt = await bus.send({ to: 'Other', message: 'run the suite', sender: senderA });

  assert.equal(receipt.delivered, true);
  assert.equal(host.prompts.length, 1);
  assert.equal(host.prompts[0].requestId, `session-bus:${receipt.messageId}`);
  assert.equal(host.prompts[0].sessionId, 'session-other002');
  assert.equal(host.prompts[0].mode, 'queue');
  assert.equal(host.inbox.nextTurn.length, 0);
  assert.equal(host.flushes.length, 0);
});

test('a Host without the Agent API falls back to the prompt path', async () => {
  const host = createHost({ noResolveAgent: true });
  const bus = createBus(host);
  const receipt = await bus.send({ to: 'Other', message: 'run the suite', sender: senderA });

  assert.equal(receipt.delivered, true);
  assert.equal(host.prompts.length, 1);
  assert.equal(host.inbox.nextTurn.length, 0);
});

test('a Host without a Session store still delivers, it only skips the flush', async () => {
  const host = createHost({ noSessionsService: true });
  const bus = createBus(host);
  const receipt = await bus.send({ to: 'Other', message: 'run the suite', sender: senderA });

  assert.equal(receipt.delivered, true);
  assert.equal(host.inbox.nextTurn.length, 1);
  assert.equal(host.prompts.length, 0);
});

test('a failed Agent resolution is reported as delivery_failed', async () => {
  const host = createHost({ agentError: 'session/agent-busy: target refused to resume' });
  const bus = createBus(host);
  await assert.rejects(
    () => bus.send({ to: 'Other', message: 'run the suite', sender: senderA }),
    /\[delivery_failed\]/,
  );
  assert.equal(host.inbox.nextTurn.length, 0);
});

test('a notice-mode spawn names the new Session from the first line of its message', async () => {
  const host = withSpawn(createHost());
  const bus = createBus(host);
  const receipt = await bus.spawn({
    message: '## 修好登录\n先看 test/login.test.mjs，然后跑一遍全部用例。',
    workspace: 'ws-a',
    sender: senderA,
  });

  assert.equal(receipt.created, true);
  assert.equal(receipt.delivered, true);
  assert.equal(host.inbox.nextTurn.length, 1);
  // The rename is the only way a notice-mode spawn gets a usable title: DSH's
  // automatic title ignores messages whose source is not `user`.
  assert.deepEqual(host.renames, [{ sessionId: receipt.sessionId, title: '修好登录' }]);
});

test('a bubble-mode spawn keeps the automatic first-prompt title', async () => {
  const host = withSpawn(createHost());
  const bus = createBus(host, { inboundPresentation: 'bubble' });
  const receipt = await bus.spawn({ message: 'start here', workspace: 'ws-a', sender: senderA });

  assert.equal(receipt.delivered, true);
  assert.equal(host.prompts.length, 1);
  assert.deepEqual(host.renames, []);
});

test('a re-adopted spawn keeps the first title and skips the rename', async () => {
  const host = withSpawn(createHost());
  // A retried spawn must first find no Session under its derived id.
  host.sessionController.inspect = async () => {
    throw new Error('session/not-found');
  };
  const bus = createBus(host);
  const first = await bus.spawn({ message: '## 第一次标题', workspace: 'ws-a', sender: senderA, spawnKey: 'job-1' });
  assert.equal(first.created, true);
  assert.equal(host.renames.length, 1);

  // The retry sees the Session the first attempt created.
  host.sessionController.inspect = async () => ({ meta: { id: first.sessionId }, inheritedEventCount: 0, events: [] });
  const again = await bus.spawn({ message: '## 第二次标题', workspace: 'ws-a', sender: senderA, spawnKey: 'job-1' });
  assert.equal(again.created, false);
  assert.equal(again.sessionId, first.sessionId);
  assert.equal(host.renames.length, 1);
});

test('a title service that refuses leaves the spawn successful', async () => {
  const host = withSpawn(createHost());
  host.sessionController.rename = async () => {
    throw new Error('gateway/internal: renaming is unavailable');
  };
  const warnings = [];
  const bus = createBus(host, {}, { warn: (line) => warnings.push(line) });
  const receipt = await bus.spawn({ message: '## 标题', workspace: 'ws-a', sender: senderA });

  assert.equal(receipt.delivered, true);
  assert.equal(receipt.created, true);
  assert.equal(host.inbox.nextTurn.length, 1);
  assert.match(warnings.join('\n'), /spawned "session-spawn001" without a title/);
});

// --- interrupt delivery: a conclusion must reach a busy peer now ------------

/** The peer Session that owns the agent double in createHost. */
const senderB = { id: 'session-other002', title: 'Other', cwd: 'C:\\work\\b' };

/** Send a message from the peer to this Session and return its receipt. */
async function peerSendsToSelf(bus) {
  return bus.send({ to: 'Main', message: 'my conclusion is X', sender: senderB });
}

/** Drop whatever the Host double collected so a test starts from an empty inbox. */
function clearInbox(host) {
  host.inbox.nextTurn.length = 0;
  host.inbox.nextStep.length = 0;
}

test('interrupt cuts into the running turn so the peer sees the conclusion now', async () => {
  const host = createHost();
  host.agent.status = 'running';
  const bus = createBus(host);
  const receipt = await bus.send({
    to: 'Other',
    message: 'stop: the schema is locked, do not edit it',
    mode: 'interrupt',
    sender: senderA,
  });

  assert.equal(receipt.delivered, true);
  assert.equal(receipt.mode, 'interrupt');
  assert.equal(receipt.interrupted, true);
  // Steered into the live step instead of queued behind the turn.
  assert.equal(host.inbox.nextStep.length, 1);
  assert.equal(host.inbox.nextTurn.length, 0);
  assert.equal(host.prompts.length, 0);
  assert.match(receipt.note, /injected into it immediately/);

  const envelope = parseEnvelope(host.inbox.nextStep[0].content[0].text);
  assert.equal(envelope.mode, 'interrupt');
  assert.match(host.inbox.nextStep[0].content[0].text, /newer information/);
});

test('interrupt wakes an idle peer like queue instead of parking a step', async () => {
  const host = createHost();
  // The Session row is stale: it still says running, the live Agent does not.
  assert.equal(host.agent.status, 'idle');
  const bus = createBus(host);
  const receipt = await bus.send({ to: 'Other', message: 'fyi', mode: 'interrupt', sender: senderA });

  assert.equal(receipt.mode, 'interrupt');
  assert.equal(receipt.interrupted, false);
  assert.equal(host.inbox.nextTurn.length, 1);
  assert.equal(host.inbox.nextStep.length, 0);
});

test('answering the peer\'s own message is upgraded to an interrupt while it runs', async () => {
  const host = createHost();
  const bus = createBus(host);
  const question = await peerSendsToSelf(bus);
  clearInbox(host);
  host.agent.status = 'running';

  const receipt = await bus.send({
    to: 'Other',
    message: 'here is the conclusion you asked for',
    sender: senderA,
    replyTo: question.messageId,
  });

  assert.equal(receipt.mode, 'interrupt');
  assert.equal(receipt.interrupted, true);
  assert.equal(host.inbox.nextStep.length, 1);
  assert.equal(host.inbox.nextTurn.length, 0);
  assert.match(receipt.note, /answered the target's own message/);
});

test('the automatic interrupt upgrade can be disabled or opted out', async () => {
  // interruptReplies: false keeps the old queue behaviour.
  const quiet = createHost();
  const quietBus = createBus(quiet, { interruptReplies: false });
  const question = await peerSendsToSelf(quietBus);
  clearInbox(quiet);
  quiet.agent.status = 'running';
  const queued = await quietBus.send({
    to: 'Other', message: 'answer', sender: senderA, replyTo: question.messageId,
  });
  assert.equal(queued.mode, 'queue');
  assert.equal(queued.interrupted, false);
  assert.equal(quiet.inbox.nextTurn.length, 1);

  // An explicit mode always wins over the upgrade.
  const host = createHost();
  const bus = createBus(host);
  const asked = await peerSendsToSelf(bus);
  clearInbox(host);
  host.agent.status = 'running';
  const explicit = await bus.send({
    to: 'Other', message: 'answer later', mode: 'queue', sender: senderA, replyTo: asked.messageId,
  });
  assert.equal(explicit.mode, 'queue');
  assert.equal(host.inbox.nextTurn.length, 1);
  assert.equal(host.inbox.nextStep.length, 0);
});

test('defaultMode "interrupt" cuts in without naming the mode per message', async () => {
  const host = createHost();
  host.agent.status = 'running';
  const bus = createBus(host, { defaultMode: 'interrupt' });
  const receipt = await bus.send({ to: 'Other', message: 'correction', sender: senderA });

  assert.equal(receipt.mode, 'interrupt');
  assert.equal(receipt.interrupted, true);
  assert.equal(host.inbox.nextStep.length, 1);
});

test('the prompt fallback maps interrupt onto steer only for a running target', async () => {
  const running = createHost();
  const runningBus = createBus(running, { inboundPresentation: 'bubble' });
  await runningBus.send({ to: 'Other', message: 'conclusion', mode: 'interrupt', sender: senderA });
  assert.equal(running.prompts.length, 1);
  assert.equal(running.prompts[0].mode, 'steer');

  const idle = createHost();
  idle.sessions[1].running = false;
  const idleBus = createBus(idle, { inboundPresentation: 'bubble' });
  await idleBus.send({ to: 'Other', message: 'conclusion', mode: 'interrupt', sender: senderA });
  assert.equal(idle.prompts[0].mode, 'queue');
});

test('the envelope carries the interrupt marker only for interrupt deliveries', () => {
  const base = {
    fromId: 'session-main0001',
    hop: 1,
    maxHops: 8,
    messageId: 'msg000000001',
    threadId: 't-1',
    replyTo: 'msg000000000',
    time: '2026-10-26T00:00:00.000Z',
    text: 'body',
  };
  const interrupt = renderEnvelope({ ...base, mode: 'interrupt' });
  assert.match(interrupt, / mode=interrupt/);
  assert.match(interrupt, /newer information/);
  assert.equal(parseEnvelope(interrupt).mode, 'interrupt');

  const normal = renderEnvelope(base);
  assert.doesNotMatch(normal, /mode=interrupt/);
  assert.doesNotMatch(normal, /newer information/);
  assert.equal(parseEnvelope(normal).mode, undefined);
});

test('a title service that refuses leaves the spawn successful', async () => {
  const host = withSpawn(createHost());
  host.sessionController.rename = async () => {
    throw new Error('gateway/internal: renaming is unavailable');
  };
  const warnings = [];
  const bus = createBus(host, {}, { warn: (line) => warnings.push(line) });
  const receipt = await bus.spawn({ message: '## 标题', workspace: 'ws-a', sender: senderA });

  assert.equal(receipt.delivered, true);
  assert.equal(receipt.created, true);
  assert.equal(host.inbox.nextTurn.length, 1);
  assert.match(warnings.join('\n'), /spawned "session-spawn001" without a title/);
});
