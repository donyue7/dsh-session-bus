import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, TARGET_PERMISSION_VALUES, normalizeConfig, permissionRank } from '../lib/config.js';

test('an empty config yields every documented default', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig('nonsense'), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig({}), DEFAULT_CONFIG);
});

test('the permission step defaults to delegating the caller level', () => {
  assert.equal(DEFAULT_CONFIG.targetPermission, 'delegate');
  assert.deepEqual(TARGET_PERMISSION_VALUES, ['delegate', 'inherit', 'read-only', 'workspace-write', 'danger-full-access']);
});

test('targetPermission accepts only known values', () => {
  for (const value of TARGET_PERMISSION_VALUES) assert.equal(normalizeConfig({ targetPermission: value }).targetPermission, value);
  assert.equal(normalizeConfig({ targetPermission: 'full' }).targetPermission, 'delegate');
  assert.equal(normalizeConfig({ targetPermission: true }).targetPermission, 'delegate');
});

test('permissionRank orders the presets and isolates unknown ones', () => {
  assert.ok(permissionRank('read-only') < permissionRank('workspace-write'));
  assert.ok(permissionRank('workspace-write') < permissionRank('danger-full-access'));
  // `custom` (and anything unrecognized) must never be re-configured away.
  assert.ok(permissionRank('danger-full-access') < permissionRank('custom'));
  assert.ok(permissionRank('danger-full-access') < permissionRank(undefined));
});

test('malformed scalars fall back instead of reaching the core', () => {
  const config = normalizeConfig({
    enabled: 'yes',
    maxHops: 0,
    maxMessageChars: 10 ** 9,
    defaultMode: 'interrupt',
    deliveryTimeoutMs: 1,
    listLimit: 3.5,
    audit: 'no',
  });
  assert.equal(config.enabled, true);
  assert.equal(config.maxHops, DEFAULT_CONFIG.maxHops);
  assert.equal(config.maxMessageChars, DEFAULT_CONFIG.maxMessageChars);
  assert.equal(config.defaultMode, 'queue');
  assert.equal(config.deliveryTimeoutMs, DEFAULT_CONFIG.deliveryTimeoutMs);
  assert.equal(config.listLimit, DEFAULT_CONFIG.listLimit);
  assert.equal(config.audit, true);
});

test('valid bounds are kept, including the edges', () => {
  const config = normalizeConfig({ maxHops: 1, maxMessageChars: 200000, deliveryTimeoutMs: 1000, listLimit: 200, defaultMode: 'steer', audit: false });
  assert.equal(config.maxHops, 1);
  assert.equal(config.maxMessageChars, 200000);
  assert.equal(config.deliveryTimeoutMs, 1000);
  assert.equal(config.listLimit, 200);
  assert.equal(config.defaultMode, 'steer');
  assert.equal(config.audit, false);
});
