import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, inject, name } from '../lib/index.js';
import { parseEnvelope } from '../lib/envelope.js';

const SELF = 'session-self0001';

/** A fake Host good enough to mount the plugin and call its tools. */
function createFakeContext(options = {}) {
  const registered = [];
  const sections = [];
  const prompts = [];
  const sessions = [
    { sessionId: SELF, cwd: 'C:\\work\\a', updatedAt: 2000, running: false, agentAvailable: true, projections: { values: { title: 'Caller' } } },
    { sessionId: 'session-peer0002', cwd: 'C:\\work\\b', updatedAt: 1000, running: false, agentAvailable: true, projections: { values: { title: 'Peer' } } },
  ];
  // Live-Session store: the plugin reads it to find the Session object a
  // permission preset is switched on.
  const live = new Map(sessions.map((row) => [row.sessionId, { id: row.sessionId }]));
  const presetOf = new Map(Object.entries({ [SELF]: 'danger-full-access', 'session-peer0002': 'workspace-write', ...options.presets }));
  const permissionCalls = [];
  const permissionPresets = options.permissionPresets ?? {
    current: (session) => presetOf.get(session.id),
    set: (session, name) => {
      permissionCalls.push({ sessionId: session.id, name });
      presetOf.set(session.id, name);
    },
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: { register: (definition) => { registered.push(definition); return () => {}; } },
    inject: (deps, callback) => { callback({ systemPrompt: { section: (section) => { sections.push(section); return () => {}; } } }); },
    get: (key) => (key === 'workspaceRegistry'
      ? { list: () => [{ id: 'ws-a', path: 'C:\\work\\a', title: 'A' }, { id: 'ws-b', path: 'C:\\work\\b', title: 'B' }] }
      : undefined),
    sessions: { get: (id) => live.get(id) },
    permissionPresets,
    sessionController: {
      list: async () => ({ items: sessions }),
      prompt: async (request) => { prompts.push(request); return { accepted: true }; },
      inspect: async () => ({ meta: {}, inheritedEventCount: 0, events: [] }),
      create: async (request) => { sessions.push({ sessionId: 'session-new00003', cwd: request.cwd ?? 'C:\\work\\a', updatedAt: 3000 }); live.set('session-new00003', { id: 'session-new00003' }); return { sessionId: 'session-new00003' }; },
    },
    registered,
    sections,
    prompts,
    // `sessions` above is the live-Session *service*; the raw rows live here.
    sessionRows: sessions,
    permissionCalls,
    presetOf,
  };
  return ctx;
}

/** A fake tool execution context for the calling Session. */
function execFor(ctx, sessionId = SELF) {
  const row = ctx.sessionRows.find((item) => item.sessionId === sessionId);
  return {
    agent: { id: sessionId, session: { header: { cwd: row.cwd, agentPreset: 'standard' }, snapshotEvents: () => [] } },
    signal: new AbortController().signal,
    callId: 'call-1',
    rootCallId: 'call-1',
  };
}

/**
 * The registry validates every result against `output.schema` with
 * `additionalProperties: false`, so a result carrying one undeclared key fails
 * the whole tool call. Assert that here instead of discovering it in the Host.
 */
function assertDeclared(tool, value) {
  const declared = new Set(Object.keys(tool.output.schema.properties ?? {}));
  for (const key of Object.keys(value)) {
    assert.equal(declared.has(key), true, `${tool.name} returned undeclared key "${key}"`);
  }
  for (const key of tool.output.schema.required ?? []) {
    assert.notEqual(value[key], undefined, `${tool.name} omitted required key "${key}"`);
  }
}

test('the plugin module is self-contained and exports the Cordis shape', () => {
  assert.equal(name, 'session-bus');
  assert.deepEqual(inject, ['tools', 'sessionController']);
  assert.equal(typeof apply, 'function');
});

test('apply registers six tools and one prompt section', () => {
  const ctx = createFakeContext();
  apply(ctx, { audit: false, persistState: false });
  assert.deepEqual(
    ctx.registered.map((tool) => tool.name).sort(),
    ['bus_find', 'bus_list', 'bus_read', 'bus_send', 'bus_spawn', 'bus_threads'],
  );
  for (const tool of ctx.registered) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(typeof tool.execute, 'function');
    assert.equal(tool.output.schema.type, 'object');
    assert.equal(tool.output.schema.additionalProperties, false);
  }
  assert.equal(ctx.sections.length, 1);
  assert.equal(ctx.sections[0].interpolate, false);
  assert.equal(ctx.sections[0].order, 2850);
  assert.match(ctx.sections[0].text, /bus_send/);
});

test('apply can be switched off and can drop either contribution', () => {
  const off = createFakeContext();
  apply(off, { enabled: false });
  assert.equal(off.registered.length, 0);

  const bare = createFakeContext();
  apply(bare, { tools: false, promptSection: false });
  assert.equal(bare.registered.length, 0);
  assert.equal(bare.sections.length, 0);
});

test('bus_list renders the Sessions and marks the caller', async () => {
  const ctx = createFakeContext();
  apply(ctx, { audit: false, persistState: false });
  const tool = ctx.registered.find((item) => item.name === 'bus_list');
  const value = await tool.execute({}, execFor(ctx));
  assertDeclared(tool, value);
  assert.equal(value.total, 2);
  assert.equal(value.sessions.find((row) => row.isSelf).sessionId, SELF);
  const text = tool.output.render({}, value)[0].text;
  assert.match(text, /session-peer0002/);
  assert.match(text, /Peer/);
});

test('bus_send pushes a parseable envelope into the named Session', async () => {
  const ctx = createFakeContext();
  apply(ctx, { audit: false, persistState: false });
  const tool = ctx.registered.find((item) => item.name === 'bus_send');
  const value = await tool.execute({ to: 'Peer', message: 'run the suite' }, execFor(ctx));

  assertDeclared(tool, value);
  assert.equal(value.delivered, true);
  assert.equal(value.sessionId, 'session-peer0002');
  assert.equal(value.crossWorkspace, true);
  assert.equal(ctx.prompts.length, 1);
  const envelope = parseEnvelope(ctx.prompts[0].content[0].text);
  assert.equal(envelope.from, SELF);
  assert.equal(envelope.fromTitle, undefined);
  assert.equal(envelope.body, 'run the suite');
  assert.equal(ctx.prompts[0].requestId.startsWith('session-bus:'), true);
  assert.match(tool.output.render({}, value)[0].text, /Delivered to session-peer0002/);
});

test('bus_send rejects malformed arguments before touching the Host', async () => {
  const ctx = createFakeContext();
  apply(ctx, { audit: false, persistState: false });
  const tool = ctx.registered.find((item) => item.name === 'bus_send');
  await assert.rejects(() => tool.execute({ message: 'no target' }, execFor(ctx)), /missing required property "to"/);
  await assert.rejects(() => tool.execute({ to: 'Peer', message: 'x', mode: 'now' }, execFor(ctx)), /must be one of \["queue","steer"\]/);
  await assert.rejects(() => tool.execute({ to: 'Peer', message: 'x', extra: 1 }, execFor(ctx)), /not a declared property/);
  await assert.rejects(() => tool.execute({ to: 'Peer', message: 'x', force: 'yes' }, execFor(ctx)), /must be a boolean/);
  assert.equal(ctx.prompts.length, 0);
});

test('bus_send reports an unknown target without delivering', async () => {
  const ctx = createFakeContext();
  apply(ctx, { audit: false, persistState: false });
  const tool = ctx.registered.find((item) => item.name === 'bus_send');
  await assert.rejects(() => tool.execute({ to: 'nobody', message: 'hi' }, execFor(ctx)), /no targetable Session matches/);
  assert.equal(ctx.prompts.length, 0);
});

test('bus_spawn creates a Session in the named workspace and starts it', async () => {
  const ctx = createFakeContext();
  apply(ctx, { audit: false, persistState: false });
  const tool = ctx.registered.find((item) => item.name === 'bus_spawn');
  const value = await tool.execute({ message: 'start', workspace: 'B' }, execFor(ctx));
  assertDeclared(tool, value);
  assert.equal(value.created, true);
  assert.equal(value.sessionId, 'session-new00003');
  assert.equal(ctx.prompts.length, 1);
  assert.equal(ctx.prompts[0].sessionId, 'session-new00003');
});

test('bus_read returns an empty transcript without waking anything', async () => {
  const ctx = createFakeContext();
  apply(ctx, { audit: false, persistState: false });
  const tool = ctx.registered.find((item) => item.name === 'bus_read');
  const value = await tool.execute({ session: 'self' }, execFor(ctx));
  assertDeclared(tool, value);
  assert.equal(value.sessionId, SELF);
  assert.deepEqual(value.messages, []);
  assert.equal(ctx.prompts.length, 0);
  assert.match(tool.output.render({}, value)[0].text, /no user or assistant messages yet/);
});

test('configuration bounds are enforced end to end', async () => {
  const ctx = createFakeContext();
  apply(ctx, { audit: false, persistState: false, spoolLongMessages: false, maxMessageChars: 8, allowCrossWorkspace: false });
  const send = ctx.registered.find((item) => item.name === 'bus_send');
  await assert.rejects(() => send.execute({ to: 'Peer', message: '0123456789' }, execFor(ctx)), /above the configured limit/);
  await assert.rejects(() => send.execute({ to: 'Peer', message: 'short' }, execFor(ctx)), /cross-workspace delivery is disabled/);
  assert.equal(ctx.prompts.length, 0);
});

test('delegation raises the target to the caller permission preset', async () => {
  // Caller danger-full-access, target workspace-write: without this the woken
  // Session cannot start pwsh and the delegated task cannot run at all.
  const ctx = createFakeContext();
  apply(ctx, { audit: false, persistState: false });
  const tool = ctx.registered.find((item) => item.name === 'bus_send');
  const value = await tool.execute({ to: 'Peer', message: 'run the suite' }, execFor(ctx));

  assert.deepEqual(ctx.permissionCalls, [{ sessionId: 'session-peer0002', name: 'danger-full-access' }]);
  assert.equal(value.permission, 'danger-full-access');
  assert.match(value.note, /Permission raised to "danger-full-access" \(was "workspace-write"\)/);
  assert.match(tool.output.render({}, value)[0].text, /permission=danger-full-access/);
  // The receiving Session is told why it can suddenly do more.
  assert.match(ctx.prompts[0].content[0].text, /switched to the "danger-full-access" permission preset/);
});

test('delegation never lowers a target preset', async () => {
  const ctx = createFakeContext({ presets: { [SELF]: 'read-only' } });
  apply(ctx, { audit: false, persistState: false });
  const tool = ctx.registered.find((item) => item.name === 'bus_send');
  const value = await tool.execute({ to: 'Peer', message: 'hi' }, execFor(ctx));
  assert.deepEqual(ctx.permissionCalls, []);
  assert.equal(value.permission, 'workspace-write');
  assert.match(value.note, /left at "workspace-write"/);
  assert.doesNotMatch(ctx.prompts[0].content[0].text, /permission preset/);
});

test('an equal or unknown caller preset leaves the target alone', async () => {
  const same = createFakeContext({ presets: { [SELF]: 'workspace-write' } });
  apply(same, { audit: false, persistState: false });
  await same.registered.find((item) => item.name === 'bus_send').execute({ to: 'Peer', message: 'hi' }, execFor(same));
  assert.deepEqual(same.permissionCalls, []);

  const custom = createFakeContext({ presets: { [SELF]: 'custom' } });
  apply(custom, { audit: false, persistState: false });
  const value = await custom.registered.find((item) => item.name === 'bus_send').execute({ to: 'Peer', message: 'hi' }, execFor(custom));
  assert.deepEqual(custom.permissionCalls, []);
  assert.equal(value.permission, 'workspace-write');
});

test('config can disable or pin the permission step', async () => {
  const inherit = createFakeContext();
  apply(inherit, { audit: false, persistState: false, targetPermission: 'inherit' });
  const inherited = await inherit.registered.find((item) => item.name === 'bus_send').execute({ to: 'Peer', message: 'hi' }, execFor(inherit));
  assert.deepEqual(inherit.permissionCalls, []);
  assert.equal(inherited.permission, undefined);

  // A pinned preset is an operator decision, so it may also lower a target.
  const pinned = createFakeContext({ presets: { 'session-peer0002': 'danger-full-access' } });
  apply(pinned, { audit: false, persistState: false, targetPermission: 'read-only' });
  await pinned.registered.find((item) => item.name === 'bus_send').execute({ to: 'Peer', message: 'hi' }, execFor(pinned));
  assert.deepEqual(pinned.permissionCalls, [{ sessionId: 'session-peer0002', name: 'read-only' }]);
});

test('a permission failure is reported without losing the delivery', async () => {
  const ctx = createFakeContext({
    permissionPresets: {
      current: (session) => (session.id === SELF ? 'danger-full-access' : 'workspace-write'),
      set: () => { throw new Error('permission service offline'); },
    },
  });
  apply(ctx, { audit: false, persistState: false });
  const tool = ctx.registered.find((item) => item.name === 'bus_send');
  const value = await tool.execute({ to: 'Peer', message: 'hi' }, execFor(ctx));
  assert.equal(value.delivered, true);
  assert.equal(ctx.prompts.length, 1);
  assert.match(value.note, /Permission could not be raised \(permission service offline\)/);
});

test('bus_spawn applies the same permission rule to the new Session', async () => {
  const ctx = createFakeContext();
  apply(ctx, { audit: false, persistState: false });
  const value = await ctx.registered.find((item) => item.name === 'bus_spawn')
    .execute({ message: 'start', workspace: 'B' }, execFor(ctx));
  assert.deepEqual(ctx.permissionCalls, [{ sessionId: 'session-new00003', name: 'danger-full-access' }]);
  assert.equal(value.permission, 'danger-full-access');
});

test('a Host without the permission service still delivers', async () => {
  const ctx = createFakeContext();
  delete ctx.permissionPresets;
  apply(ctx, { audit: false, persistState: false });
  const value = await ctx.registered.find((item) => item.name === 'bus_send').execute({ to: 'Peer', message: 'hi' }, execFor(ctx));
  assert.equal(value.delivered, true);
  assert.equal(value.permission, undefined);
  assert.equal(ctx.prompts.length, 1);
});

/**
 * `persistState` is a config key; the switch the ledger actually reads is the
 * `persist` construction option that `apply` derives from it. A test suite that
 * only sets the config key would still write into a real DSH_HOME, so pin the
 * wiring from both sides: off means no file, default means a file.
 */
test('persistState=false reaches the ledger, and the default still persists', async () => {
  const offHome = mkdtempSync(join(tmpdir(), 'session-bus-off-'));
  const onHome = mkdtempSync(join(tmpdir(), 'session-bus-on-'));
  const previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = offHome;
    const quiet = createFakeContext();
    apply(quiet, { audit: false, persistState: false });
    await quiet.registered.find((item) => item.name === 'bus_send').execute({ to: 'Peer', message: 'hi' }, execFor(quiet));

    process.env.DSH_HOME = onHome;
    const noisy = createFakeContext();
    apply(noisy, { audit: false });
    await noisy.registered.find((item) => item.name === 'bus_send').execute({ to: 'Peer', message: 'hi' }, execFor(noisy));

    // The ledger write is debounced; wait past the window before judging.
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(existsSync(join(offHome, 'session-bus', 'state.json')), false, 'persistState:false must write no ledger');
    assert.equal(existsSync(join(onHome, 'session-bus', 'state.json')), true, 'the default must still persist');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(offHome, { recursive: true, force: true });
    rmSync(onHome, { recursive: true, force: true });
  }
});
