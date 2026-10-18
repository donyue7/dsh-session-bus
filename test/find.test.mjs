/**
 * Tests for `bus_find`: routing a question to the Session that can answer it.
 *
 * Routing is a retrieval problem, so both backends are covered: the Host
 * full-text index (a fake `sessionQuery` that reports which Sessions discuss the
 * question) and the metadata fallback used when that index is not mounted.
 * Nothing here may wake a Session.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionBus } from '../lib/bus.js';
import { registerTools } from '../lib/tools.js';

const SELF = 'session-self0001';
const PEER = 'session-peer0002';
const OTHER = 'session-other003';
const SUB = 'session-sub0004';

const AT = 1760000000000;

/** Minimal Host double: the caller, two peers in other directories, one subagent. */
function createHost(options = {}) {
  const sessions = [
    { sessionId: SELF, cwd: 'C:\\work\\a', updatedAt: 3000, running: false, agentAvailable: true, projections: { values: { title: '开发中' } } },
    { sessionId: PEER, cwd: 'C:\\work\\geren', updatedAt: 2000, running: false, agentAvailable: true, projections: { values: { title: '激励模块开发' } } },
    { sessionId: OTHER, cwd: 'C:\\work\\bscm', updatedAt: 1000, running: true, agentAvailable: true, projections: { values: { title: '代客下单模块开发' } } },
    { sessionId: SUB, cwd: 'C:\\work\\a', updatedAt: 900, origin: 'subagent', running: false, agentAvailable: true, projections: { values: { title: '子会话' } } },
  ];
  const prompts = [];
  const live = new Map(sessions.map((row) => [row.sessionId, { id: row.sessionId }]));
  const presetOf = new Map();
  return {
    logger: { info() {}, warn() {}, error() {} },
    on() { return () => {}; },
    get(key) {
      if (key === 'workspaceRegistry') return { list: () => [{ id: 'ws-a', path: 'C:\\work\\a', title: 'A' }] };
      if (key === 'sessionQuery') return options.sessionQuery;
      return undefined;
    },
    sessions: { get: (id) => live.get(id) },
    agents: { get: () => ({ status: 'idle', inbox: { nextTurn: [], nextStep: [] } }) },
    permissionPresets: {
      current: (session) => presetOf.get(session.id) ?? 'workspace-write',
      set: (session, name) => { presetOf.set(session.id, name); },
    },
    sessionController: {
      list: async () => ({ items: sessions }),
      prompt: async (request) => { prompts.push(request); return { accepted: true }; },
      inspect: async () => ({ meta: {}, inheritedEventCount: 0, events: [] }),
      create: async () => ({ sessionId: 'session-new1' }),
    },
    prompts,
    sessionRows: sessions,
  };
}

/** Build a bus over the Host double, never touching a real DSH home. */
function createBus(host, config = {}) {
  return createSessionBus({
    ctx: host,
    config: { audit: false, persistState: false, spoolLongMessages: false, ...config },
    persist: false,
    clock: () => AT,
  });
}

/** A fake `sessionQuery` service that answers with prepared hits. */
function fakeSearch(items) {
  const calls = [];
  return {
    calls,
    async searchSessions(request, exec) {
      calls.push({ request, exec });
      return { items };
    },
  };
}

/** One session-level search hit, shaped like `SessionSearchHit`. */
function hit(sessionId, snippet, extra = {}) {
  return {
    header: { id: sessionId, cwd: undefined },
    live: false,
    persisted: true,
    bestMatch: { sessionId, seq: 7, type: 'assistant/message', time: AT, surface: 'current', snippet },
    ...extra,
  };
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

const self = { id: SELF, cwd: 'C:\\work\\a' };

test('bus_find returns content hits and only Sessions the bus can address', async () => {
  const search = fakeSearch([
    hit(SELF, 'the caller discussing its own topic'),
    hit(SUB, 'a subagent turn'),
    hit(PEER, '激励计算：seasonal_item 20%'),
    hit('session-ghost', 'a Session the bus cannot see'),
  ]);
  const host = createHost({ sessionQuery: search });
  const bus = createBus(host);
  const result = await bus.find({ question: '激励怎么算', sender: self });

  assert.equal(result.indexed, true);
  assert.equal(result.searched, 4);
  assert.equal(result.returned, 1);
  assert.equal(result.candidates[0].sessionId, PEER);
  assert.equal(result.candidates[0].title, '激励模块开发');
  assert.equal(result.candidates[0].busy, false);
  assert.equal(result.candidates[0].live, false);
  assert.equal(result.candidates[0].sameWorkspace, false);
  assert.equal(result.candidates[0].hasThread, false);
  assert.match(result.candidates[0].snippet, /seasonal_item/);
  assert.match(result.candidates[0].why, /对话内容命中/);
  assert.equal(result.candidates[0].matchedType, 'assistant/message');
  assert.equal(result.candidates[0].matchedAt, new Date(AT).toISOString());
  assert.equal(search.calls.length, 1);
  assert.equal(search.calls[0].request.query, '激励怎么算');
  assert.ok(search.calls[0].request.limit >= 12);
  assert.equal(result.ambiguous, false, 'one clear content hit is a clear route');
  assert.match(result.nextStep, /唯一明确候选/);
  assert.equal(host.prompts.length, 0, 'routing must never wake a Session');
});

test('bus_find marks an existing thread and never lists one Session twice', async () => {
  const host = createHost({ sessionQuery: fakeSearch([hit(PEER, 'first match'), hit(PEER, 'second match')]) });
  const bus = createBus(host);
  await bus.send({ to: PEER, message: 'please look at this', sender: self });
  const result = await bus.find({ question: '激励', sender: self });

  assert.equal(result.returned, 1);
  assert.equal(result.candidates[0].sessionId, PEER);
  assert.equal(result.candidates[0].hasThread, true);
});

test('bus_find truncates the candidate list to the requested limit', async () => {
  const host = createHost({ sessionQuery: fakeSearch([hit(PEER, 'a'), hit(OTHER, 'b')]) });
  const bus = createBus(host);
  const result = await bus.find({ question: '模块', sender: self, limit: 1 });

  assert.equal(result.returned, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].sessionId, PEER);
  assert.equal(result.ambiguous, true, 'more matches exist than were returned, so the route is not certain');
  assert.match(result.nextStep, /多个/);
});

test('bus_find falls back to title matching when content search is not mounted', async () => {
  const host = createHost();
  const bus = createBus(host);
  const result = await bus.find({ question: '激励 怎么算', sender: self });

  assert.equal(result.indexed, false);
  assert.equal(result.returned, 2, 'both peers are addressable, the subagent and the caller are not');
  assert.equal(result.candidates[0].sessionId, PEER);
  assert.match(result.candidates[0].why, /标题或工作目录命中/);
  assert.match(result.note, /全文索引不可用/);
  assert.equal(result.candidates[0].snippet, undefined);
  assert.equal(result.ambiguous, true, 'a metadata guess is never a certain route');
  assert.match(result.nextStep, /全文索引不可用/);
});

test('bus_find survives a failing search backend and still ranks candidates', async () => {
  const provider = { async searchSessions() { throw new Error('index offline'); } };
  const host = createHost({ sessionQuery: provider });
  const bus = createBus(host);
  const result = await bus.find({ question: 'zzz-unknown-topic', sender: self });

  assert.equal(result.indexed, false);
  assert.equal(result.returned, 2);
  assert.equal(result.candidates[0].sessionId, PEER, 'nothing matched, so the most recently active peer wins');
  assert.match(result.candidates[0].why, /最近活跃/);
  assert.equal(result.ambiguous, true);
});

test('bus_find flags several plausible matches as ambiguous and hands the choice to the user', async () => {
  const host = createHost({ sessionQuery: fakeSearch([hit(PEER, '激励口径'), hit(OTHER, '代客下单也会触发激励')]) });
  const bus = createBus(host);
  const result = await bus.find({ question: '激励', sender: self });

  assert.equal(result.returned, 2);
  assert.equal(result.ambiguous, true);
  assert.match(result.nextStep, /多个/);
  assert.match(result.nextStep, /用户/);
});

test('bus_find refuses to pretend certainty when only metadata knows', async () => {
  // The index answers, but only for the caller and a subagent: no addressable
  // Session genuinely discussed the topic, so the metadata fallback is a guess.
  const host = createHost({ sessionQuery: fakeSearch([hit(SELF, 'own topic'), hit(SUB, 'subagent topic')]) });
  const bus = createBus(host);
  const result = await bus.find({ question: '激励', sender: self });

  assert.equal(result.indexed, true);
  assert.equal(result.returned, 2, 'the metadata fallback still lists addressable Sessions');
  assert.equal(result.ambiguous, true);
  assert.match(result.nextStep, /没有会话的对话真正讨论过/);
  assert.match(result.nextStep, /bus_spawn/);
});

test('bus_find with nothing to offer tells the caller to ask the user, not to invent a target', async () => {
  const host = createHost({ sessionQuery: fakeSearch([hit(SELF, 'own topic'), hit(SUB, 'subagent topic')]) });
  // Keep only the caller and the subagent, so even the metadata fallback has
  // nothing addressable to list.
  const kept = host.sessionRows.filter((row) => row.sessionId === SELF || row.sessionId === SUB);
  host.sessionRows.length = 0;
  host.sessionRows.push(...kept);
  const bus = createBus(host);
  const result = await bus.find({ question: '无人能答的话题', sender: self });

  assert.equal(result.returned, 0);
  assert.equal(result.ambiguous, true);
  assert.match(result.nextStep, /不要自己挑/);
  assert.match(result.nextStep, /bus_spawn/);
});

test('bus_find refuses an empty question with a coded error', async () => {
  const bus = createBus(createHost());
  await assert.rejects(
    () => bus.find({ question: '   ', sender: self }),
    (error) => error.code === 'empty_query',
  );
});

test('the bus_find tool declares exactly the fields it returns, and renders text', async () => {
  const host = createHost({ sessionQuery: fakeSearch([hit(PEER, '激励计算规则 seasonal_item')]) });
  const registered = [];
  host.tools = { register: (definition) => { registered.push(definition); return () => {}; } };
  const bus = createBus(host);
  registerTools(host, bus);

  const tool = registered.find((item) => item.name === 'bus_find');
  assert.ok(tool, 'bus_find must be registered');
  const value = await tool.execute({ question: '激励怎么算' }, execFor(host));

  const declared = new Set(Object.keys(tool.output.schema.properties));
  for (const key of Object.keys(value)) assert.equal(declared.has(key), true, `undeclared result key "${key}"`);
  assert.deepEqual(Object.keys(value).sort(), ['ambiguous', 'candidates', 'indexed', 'nextStep', 'note', 'query', 'returned', 'searched']);

  const itemDeclared = new Set(Object.keys(tool.output.schema.properties.candidates.items.properties));
  for (const key of Object.keys(value.candidates[0])) {
    assert.equal(itemDeclared.has(key), true, `undeclared candidate key "${key}"`);
  }
  for (const key of tool.output.schema.properties.candidates.items.required) {
    assert.notEqual(value.candidates[0][key], undefined, `candidate omitted required key "${key}"`);
  }

  const rendered = tool.output.render({}, value);
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /激励模块开发/);
  assert.match(rendered[0].text, /bus_send/);
});
