import test from 'node:test';
import assert from 'node:assert/strict';

import { defineTool, validateArgs, projectToSchema } from '../lib/toolkit.js';

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    total: { type: 'integer' },
    note: { type: 'string' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          nested: {
            type: 'object',
            additionalProperties: false,
            properties: { kept: { type: 'string' } },
          },
        },
      },
    },
  },
};

test('projectToSchema drops undeclared keys and keeps declared ones', () => {
  const projected = projectToSchema({ total: 2, note: 'hi', extra: true, alsoExtra: { deep: 1 } }, schema);
  assert.deepEqual(projected, { total: 2, note: 'hi' });
});

test('projectToSchema treats null and undefined as absent', () => {
  assert.deepEqual(projectToSchema({ total: 1, note: null, other: undefined }, schema), { total: 1 });
});

test('projectToSchema recurses through arrays and nested objects', () => {
  const projected = projectToSchema({
    total: 1,
    rows: [{ id: 'a', stray: 1, nested: { kept: 'yes', stray: 'no' } }],
  }, schema);
  assert.deepEqual(projected, { total: 1, rows: [{ id: 'a', nested: { kept: 'yes' } }] });
});

test('projectToSchema passes through schemas it cannot narrow', () => {
  assert.deepEqual(projectToSchema({ anything: 1 }, { description: 'free form' }), { anything: 1 });
  assert.deepEqual(projectToSchema('text', { type: 'string' }), 'text');
  assert.deepEqual(projectToSchema([1, 2], { type: 'array' }), [1, 2]);
});

test('defineTool strips undeclared fields before the registry can reject the call', async () => {
  const tool = defineTool({
    name: 'demo',
    description: 'demo',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema, render: () => [{ type: 'text', text: 'ok' }] },
    async execute() {
      // A service that grows a field must not break the tool: the schema wins.
      return { total: 7, note: 'kept', surprise: 'dropped', rows: [{ id: 'r', stray: true }] };
    },
  });
  const value = await tool.execute({}, {});
  assert.deepEqual(value, { total: 7, note: 'kept', rows: [{ id: 'r' }] });
  const declared = new Set(Object.keys(schema.properties));
  for (const key of Object.keys(value)) assert.equal(declared.has(key), true);
});

test('defineTool still enforces the declared argument contract', async () => {
  const tool = defineTool({
    name: 'demo',
    description: 'demo',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { to: { type: 'string' }, mode: { type: 'string', enum: ['queue', 'steer'] } },
      required: ['to'],
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } }, render: () => [] },
    async execute() {
      return { ok: true };
    },
  });
  await assert.rejects(() => tool.execute({}, {}), /missing required property "to"/);
  await assert.rejects(() => tool.execute({ to: 'x', mode: 'now' }, {}), /must be one of \["queue","steer"\]/);
  await assert.rejects(() => tool.execute({ to: 'x', z: 1 }, {}), /not a declared property/);
  assert.deepEqual(await tool.execute({ to: 'x', mode: 'steer' }, {}), { ok: true });
});

test('validateArgs checks nested arrays and primitives', () => {
  const violations = validateArgs(schema, { total: 'two', rows: [{ id: 5 }] });
  assert.deepEqual(violations, ['"total" must be an integer', '"rows[0].id" must be a string']);
  assert.deepEqual(validateArgs(schema, 'not-an-object'), ['arguments must be a JSON object']);
  assert.deepEqual(validateArgs(schema, {}), []);
});
