/**
 * A tiny, dependency-free tool toolkit.
 *
 * DSH ships `defineTool`, but importing it means a bare `@deepseek-ai/...`
 * specifier, and a plugin that lives outside the installation (a profile
 * plugin, a workspace plugin) is loaded by plain Node resolution: its own bare
 * imports must resolve from the plugin's own directory. Every other working
 * out-of-tree plugin in this profile therefore imports nothing but `node:*`
 * and relative files — this module keeps that property while still giving the
 * registry the exact `ToolDefinition` shape it demands.
 *
 * The delivered surface is purposely the same:
 *   { name, description, parameters, output: { schema, render }, execute }
 *
 * @module dsh-session-bus/toolkit
 */

/**
 * Build one registry-ready tool definition with strict argument validation.
 * @param {object} options - tool definition.
 * @param {string} options.name - model-facing tool name.
 * @param {string} options.description - model-facing description.
 * @param {object} [options.parameters] - raw JSON Schema for the arguments.
 * @param {{schema: object, render: (args: object, value: object) => Array<object>}} options.output - result schema and renderer.
 * @param {(args: object, exec: object) => Promise<object>} options.execute - tool body.
 * @returns {object} the registry-ready definition.
 */
export function defineTool(options) {
  if (typeof options?.name !== 'string' || options.name === '') throw new Error('tool definition needs a non-empty name');
  if (typeof options.description !== 'string' || options.description === '') throw new Error(`tool "${options.name}" needs a description`);
  if (options.output === undefined || typeof options.output.render !== 'function') throw new Error(`tool "${options.name}" must declare output.render`);
  if (options.output.schema === undefined) throw new Error(`tool "${options.name}" must declare output.schema`);
  const parameters = options.parameters ?? emptyObjectSchema();
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: options.output.schema,
      render: (args, value) => options.output.render(args, value),
    },
    async execute(args, exec) {
      const violations = validateArgs(parameters, args);
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`);
      // Shape the result to the declared contract BEFORE it reaches the registry.
      // The registry validates results with `additionalProperties: false` and
      // rejects the whole call on one undeclared field — but by then the tool
      // body has already run (a Session may have been created, a message
      // delivered), so a schema drift would surface as "the tool failed" while
      // the side effect stood. Projecting here makes that class impossible.
      return projectToSchema(await options.execute(args, exec), options.output.schema);
    },
  };
}

/**
 * Keep only the fields the declared output schema describes.
 *
 * The schema is the contract: a field the schema does not declare is dropped
 * rather than shipped to a validator that would fail the call. Recurses through
 * arrays and nested objects, so item shapes are covered too. A `null` or
 * `undefined` value is treated as absent, which is how optional keys are
 * omitted rather than sent as `null`.
 *
 * @param {unknown} value - the tool body's result.
 * @param {object} schema - the declared output schema.
 * @returns {unknown} the projected result.
 */
export function projectToSchema(value, schema) {
  if (value === undefined || value === null) return value;
  if (schema?.type === 'array' && Array.isArray(value)) {
    if (schema.items === undefined) return value;
    return value.map((item) => projectToSchema(item, schema.items));
  }
  if (schema?.type === 'object' && isPlainObject(value) && isPlainObject(schema.properties)) {
    const projected = {};
    for (const key of Object.keys(schema.properties)) {
      const item = value[key];
      if (item === undefined || item === null) continue;
      projected[key] = projectToSchema(item, schema.properties[key]);
    }
    return projected;
  }
  return value;
}

/** A parameterless tool's argument schema. */
export function emptyObjectSchema() {
  return { type: 'object', additionalProperties: false, properties: {} };
}

/**
 * Validate model-supplied arguments against a raw JSON Schema subset.
 * @param {object} schema - schema with `type`, `properties`, `required`, `additionalProperties`.
 * @param {unknown} args - candidate arguments.
 * @param {string} [root] - diagnostic path prefix for nested calls.
 * @returns {string[]} path-qualified violations; empty means valid.
 */
export function validateArgs(schema, args, root = '') {
  if (!isPlainObject(args)) return [`${root === '' ? 'arguments' : `"${root.replace(/\.$/, '')}"`} must be a JSON object`];
  const properties = isPlainObject(schema?.properties) ? schema.properties : {};
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const violations = [];
  for (const key of required) {
    if (!Object.hasOwn(args, key) || args[key] === undefined) violations.push(`missing required property "${root}${key}"`);
  }
  if (schema?.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!Object.hasOwn(properties, key)) violations.push(`"${root}${key}" is not a declared property`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (spec === undefined || value === undefined) continue;
    violations.push(...checkValue(spec, value, `${root}${key}`));
  }
  return violations;
}

/** Validate one value against one schema node. */
function checkValue(spec, value, path) {
  const violations = [];
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') return [`"${path}" must be a string`];
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return [`"${path}" must be an integer`];
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`"${path}" must be a finite number`];
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return [`"${path}" must be a boolean`];
      break;
    case 'array':
      if (!Array.isArray(value)) return [`"${path}" must be an array`];
      if (spec.items !== undefined) {
        for (let index = 0; index < value.length; index += 1) {
          violations.push(...checkValue(spec.items, value[index], `${path}[${index}]`));
        }
      }
      return violations;
    case 'object':
      // `root` ends with a dot so nested keys keep one uniform path.
      return validateArgs(spec, value, `${path}.`);
    default:
      break;
  }
  if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
    violations.push(`"${path}" must be one of ${JSON.stringify(spec.enum)}`);
  }
  if (Object.hasOwn(spec, 'const') && value !== spec.const) {
    violations.push(`"${path}" must be ${JSON.stringify(spec.const)}`);
  }
  return violations;
}

/** Whether a value is a plain JSON object (not an array, not null). */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
