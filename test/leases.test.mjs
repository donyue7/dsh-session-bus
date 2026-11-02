/**
 * Tests for write leases: path normalization and overlap, the lease ledger
 * (claim, renew, conflict, force, expiry, release, persistence), and the
 * SessionBus lease/release/leases methods a tool call goes through.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { BusError, createSessionBus } from '../lib/bus.js';
import { LeaseLedger, leaseKey, leasePath, leaseRootsOverlap } from '../lib/leases.js';

const CLOCK = 1760000000000;
const TTL = 30 * 60 * 1000;
const WORKSPACE_A = 'C:\\work\\a';
const SELF = 'session-main0001';
const PEER = 'session-other002';

/** The platform's display form of a workspace-relative path. */
function display(relative) {
  return resolve(WORKSPACE_A, relative).replaceAll('/', '\\');
}

/** A minimal Host double: the lease methods need a listing and an agent. */
function createHost() {
  const workers = [
    { sessionId: SELF, cwd: WORKSPACE_A, running: false, agentAvailable: true, updatedAt: CLOCK, title: 'Main' },
    { sessionId: PEER, cwd: WORKSPACE_A, running: false, agentAvailable: true, updatedAt: CLOCK, title: 'Peer' },
  ];
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on: () => () => {},
    get: () => undefined,
    sessions: { get: () => undefined },
    agents: { get: () => ({ status: 'idle', inbox: { nextTurn: [], nextStep: [] } }) },
    sessionController: { list: async () => ({ items: workers }) },
  };
}

function createBus(config = {}) {
  return createSessionBus({
    ctx: createHost(),
    config: { audit: false, persistState: false, spoolLongMessages: false, ...config },
    persist: false,
    clock: () => CLOCK,
  });
}

const senderA = { id: SELF, title: 'A', cwd: WORKSPACE_A };
const senderB = { id: PEER, title: 'B', cwd: WORKSPACE_A };

// ---------------------------------------------------------------------------
// Path normalization and overlap
// ---------------------------------------------------------------------------

test('leasePath resolves relative paths against the workspace', () => {
  assert.equal(leasePath('src', WORKSPACE_A), display('src'));
  assert.equal(leasePath('src/views/main.js', WORKSPACE_A), display('src/views/main.js'));
  assert.equal(leasePath(display('src'), WORKSPACE_A), display('src'));
  assert.equal(leasePath('.', WORKSPACE_A), WORKSPACE_A);
});

test('leaseKey folds case only where the filesystem does', () => {
  if (process.platform === 'win32') {
    assert.equal(leaseKey('SRC', WORKSPACE_A), leaseKey('src', WORKSPACE_A));
  } else {
    assert.notEqual(leaseKey('SRC', WORKSPACE_A), leaseKey('src', WORKSPACE_A));
  }
});

test('leaseRootsOverlap lets a directory cover its children', () => {
  const root = (path) => leaseKey(path, WORKSPACE_A);
  assert.equal(leaseRootsOverlap(root('src'), root('src/views/main.js')), true);
  assert.equal(leaseRootsOverlap(root('src/views/main.js'), root('src')), true);
  assert.equal(leaseRootsOverlap(root('src'), root('src')), true);
  assert.equal(leaseRootsOverlap(root('src'), root('src2')), false);
  assert.equal(leaseRootsOverlap(root('src/views'), root('src/styles')), false);
});

// ---------------------------------------------------------------------------
// LeaseLedger
// ---------------------------------------------------------------------------

test('acquire grants a lease and reports the conflicting claim', () => {
  const ledger = new LeaseLedger({ clock: () => CLOCK });
  const first = ledger.acquire({ sessionId: SELF, workspace: WORKSPACE_A, paths: ['src'], note: 'editing views', ttlMs: TTL });
  assert.equal(first.granted, true);
  assert.match(first.lease.leaseId, /^l-[0-9a-f]{12}$/);
  assert.equal(first.lease.paths[0], display('src'));
  assert.equal(first.lease.expiresAt, CLOCK + TTL);

  const second = ledger.acquire({ sessionId: PEER, workspace: WORKSPACE_A, paths: ['src/views/main.js'], ttlMs: TTL });
  assert.equal(second.granted, false);
  assert.equal(second.conflicts.length, 1);
  assert.equal(second.conflicts[0].lease.leaseId, first.lease.leaseId);
  assert.equal(second.conflicts[0].overlap[0], leaseKey('src/views/main.js', WORKSPACE_A));
});

test('force claims the paths without deleting the other lease', () => {
  const ledger = new LeaseLedger({ clock: () => CLOCK });
  const first = ledger.acquire({ sessionId: SELF, workspace: WORKSPACE_A, paths: ['src'], ttlMs: TTL });
  const forced = ledger.acquire({ sessionId: PEER, workspace: WORKSPACE_A, paths: ['src'], force: true, ttlMs: TTL });
  assert.equal(forced.granted, true);
  assert.equal(forced.conflicts.length, 1);
  assert.equal(ledger.list().length, 2);
  assert.ok(ledger.list().some((lease) => lease.leaseId === first.lease.leaseId));
});

test('renewing the same roots keeps the lease id and extends the deadline', () => {
  let now = CLOCK;
  const ledger = new LeaseLedger({ clock: () => now });
  const first = ledger.acquire({ sessionId: SELF, workspace: WORKSPACE_A, paths: ['src'], note: 'editing', ttlMs: TTL });
  now += 10 * 60 * 1000;
  const renewed = ledger.acquire({ sessionId: SELF, workspace: WORKSPACE_A, paths: ['src'], note: 'still editing', ttlMs: TTL });
  assert.equal(renewed.granted, true);
  assert.equal(renewed.lease.leaseId, first.lease.leaseId);
  assert.equal(renewed.lease.note, 'still editing');
  assert.equal(renewed.lease.expiresAt, now + TTL);
  assert.equal(ledger.list().length, 1);
});

test('an expired lease stops blocking and shows up only when requested', () => {
  let now = CLOCK;
  const ledger = new LeaseLedger({ clock: () => now });
  const first = ledger.acquire({ sessionId: SELF, workspace: WORKSPACE_A, paths: ['src'], ttlMs: TTL });
  now += TTL + 60 * 1000;
  const second = ledger.acquire({ sessionId: PEER, workspace: WORKSPACE_A, paths: ['src'], ttlMs: TTL });
  assert.equal(second.granted, true);
  const active = ledger.list();
  assert.equal(active.length, 1);
  assert.equal(active[0].sessionId, PEER);
  const all = ledger.list({ includeExpired: true });
  assert.equal(all.length, 2);
  assert.equal(all.find((lease) => lease.leaseId === first.lease.leaseId).expired, true);
});

test('release removes one own lease and reports unknown ids', () => {
  const ledger = new LeaseLedger({ clock: () => CLOCK });
  const first = ledger.acquire({ sessionId: SELF, workspace: WORKSPACE_A, paths: ['src'], ttlMs: TTL });
  const released = ledger.release({ sessionId: SELF, leaseId: first.lease.leaseId });
  assert.deepEqual(released.released, [first.lease.leaseId]);
  assert.deepEqual(released.missing, []);
  const again = ledger.release({ sessionId: SELF, leaseId: first.lease.leaseId });
  assert.deepEqual(again.released, []);
  assert.deepEqual(again.missing, [first.lease.leaseId]);
  const foreign = ledger.acquire({ sessionId: PEER, workspace: WORKSPACE_A, paths: ['src'], ttlMs: TTL });
  const notMine = ledger.release({ sessionId: SELF, leaseId: foreign.lease.leaseId });
  assert.deepEqual(notMine.missing, [foreign.lease.leaseId]);
  assert.equal(ledger.list().length, 1);
});

test('release all + toJSON/restore round-trip', () => {
  const ledger = new LeaseLedger({ clock: () => CLOCK });
  ledger.acquire({ sessionId: SELF, workspace: WORKSPACE_A, paths: ['src'], ttlMs: TTL });
  ledger.acquire({ sessionId: SELF, workspace: WORKSPACE_A, paths: ['docs'], ttlMs: TTL });
  const snapshot = ledger.toJSON();
  assert.equal(snapshot.leases.length, 2);
  const restored = new LeaseLedger({ clock: () => CLOCK });
  restored.restore(snapshot);
  assert.equal(restored.list().length, 2);
  assert.equal(restored.release({ sessionId: SELF, all: true }).released.length, 2);
  assert.equal(restored.list().length, 0);
});

// ---------------------------------------------------------------------------
// SessionBus lease surface
// ---------------------------------------------------------------------------

test('bus.lease claims paths against the sender workspace', async () => {
  const bus = createBus();
  const result = await bus.lease({ sender: senderA, paths: ['src'], note: 'editing views' });
  assert.equal(result.granted, true);
  assert.equal(result.sessionId, SELF);
  assert.equal(result.workspace, WORKSPACE_A);
  assert.equal(result.ttlMinutes, 30);
  assert.equal(result.expiresInMinutes, 30);
  assert.match(result.leaseId, /^l-/);
  assert.equal(result.leaseId, result.leaseId.toLowerCase());
  assert.deepEqual(result.paths, [display('src')]);
  assert.deepEqual(result.conflicts, []);
  assert.match(result.note, /Claimed 1 path/);
});

test('bus.lease refuses an overlapping claim and force overrides it', async () => {
  const bus = createBus();
  const owned = await bus.lease({ sender: senderA, paths: ['src'] });
  const refused = await bus.lease({ sender: senderB, paths: ['src/views/main.js'] });
  assert.equal(refused.granted, false);
  assert.equal(refused.conflicts.length, 1);
  assert.equal(refused.conflicts[0].sessionId, SELF);
  assert.equal(refused.conflicts[0].leaseId, owned.leaseId);
  assert.match(refused.note, /overlapping write lease/);
  assert.equal(refused.leaseId, undefined);
  assert.equal(refused.expiresAt, undefined);

  const forced = await bus.lease({ sender: senderB, paths: ['src/views/main.js'], force: true });
  assert.equal(forced.granted, true);
  assert.match(forced.leaseId, /^l-/);
  assert.equal(forced.conflicts.length, 1);
});

test('bus.lease clamps the ttl and reuses the lease on a repeat claim', async () => {
  const bus = createBus();
  const low = await bus.lease({ sender: senderA, paths: ['docs'], ttlMinutes: 0 });
  assert.equal(low.ttlMinutes, 1);
  const high = await bus.lease({ sender: senderA, paths: ['docs'], ttlMinutes: 9999 });
  assert.equal(high.ttlMinutes, 480);
  assert.equal(high.leaseId, low.leaseId);
  const fallback = createBus();
  const standard = await fallback.lease({ sender: senderA, paths: ['notes'], ttlMinutes: Number.NaN });
  assert.equal(standard.ttlMinutes, 30);
});

test('bus.lease rejects invalid paths and senders with coded refusals', async () => {
  const bus = createBus();
  await assert.rejects(
    () => bus.lease({ sender: senderA, paths: [] }),
    (error) => error instanceof BusError && error.code === 'invalid_lease_paths',
  );
  await assert.rejects(
    () => bus.lease({ sender: senderA, paths: ['   '] }),
    (error) => error instanceof BusError && error.code === 'invalid_lease_paths',
  );
  await assert.rejects(
    () => bus.lease({ sender: senderA, paths: Array.from({ length: 21 }, (_value, index) => `dir-${index}`) }),
    (error) => error instanceof BusError && error.code === 'invalid_lease_paths',
  );
  await assert.rejects(
    () => bus.lease({ sender: { cwd: WORKSPACE_A }, paths: ['src'] }),
    (error) => error instanceof BusError && error.code === 'no_sender',
  );
  await assert.rejects(
    () => bus.lease({ sender: { id: SELF }, paths: ['src'] }),
    (error) => error instanceof BusError && error.code === 'no_workspace',
  );
});

test('bus.release and bus.leases report the live view', async () => {
  const bus = createBus();
  const mine = await bus.lease({ sender: senderA, paths: ['src'] });
  await bus.lease({ sender: senderB, paths: ['docs'] });
  const listed = await bus.leases({ sender: senderA });
  assert.equal(listed.total, 2);
  assert.equal(typeof listed.note, 'string');
  assert.equal(listed.leases.find((lease) => lease.leaseId === mine.leaseId).mine, true);
  assert.equal(listed.leases.find((lease) => lease.leaseId === mine.leaseId).workspace, WORKSPACE_A);
  const filtered = await bus.leases({ sender: senderA, workspace: 'C:\\work\\zzz' });
  assert.equal(filtered.total, 0);
  assert.match(filtered.note, /No write leases/);

  const released = await bus.release({ sender: senderA, leaseId: mine.leaseId });
  assert.deepEqual(released.released, [mine.leaseId]);
  assert.match(released.note, /Released 1 write lease/);
  const missing = await bus.release({ sender: senderA, leaseId: mine.leaseId });
  assert.deepEqual(missing.missing, [mine.leaseId]);

  const rest = await bus.release({ sender: senderB });
  assert.deepEqual(rest.released.length, 1);
  const empty = await bus.release({ sender: senderB });
  assert.deepEqual(empty.released, []);
  assert.match(empty.note, /not holding any write lease/);
});
