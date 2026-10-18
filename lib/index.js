/**
 * session-bus — inter-Session messaging for DSH.
 *
 * Sessions in the same workspace, and Sessions in different workspaces, can
 * push messages into each other. Delivery goes through the exact Host path the
 * user interface uses to submit a message, so the receiving Session is resumed
 * if it is cold and starts a new turn if it is idle — no manual pausing,
 * copying, or pasting.
 *
 * The plugin imports nothing but `node:*` and its own files. Bare
 * `@deepseek-ai/...` specifiers only resolve for plugins loaded from inside the
 * DSH installation; a profile or workspace plugin is loaded by plain Node
 * resolution, so it must stay self-contained to load from any location.
 *
 * @module dsh-session-bus
 */

import { DEFAULT_CONFIG, normalizeConfig } from './config.js';
import { createSessionBus } from './bus.js';
import { registerTools } from './tools.js';
import { PROMPT_SECTION, PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER } from './prompt.js';

/** Cordis plugin name. */
export const name = 'session-bus';

/** Services the plugin needs before it can contribute anything. */
export const inject = ['tools', 'sessionController'];

/**
 * Mount the session bus on one Host.
 *
 * Config is validated by {@link normalizeConfig} rather than a Cordis schema,
 * for the same self-containment reason: `Config` would require `schemastery`.
 * Unknown keys are ignored; every malformed value falls back to its default.
 *
 * @param {object} ctx - plugin context.
 * @param {object} [config] - plugin configuration from the profile patch.
 * @returns {void}
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config);
  if (!settings.enabled) {
    info(ctx, 'session-bus is disabled by configuration');
    return;
  }
  const bus = createSessionBus({ ctx, config: settings, logger: ctx.logger, persist: settings.persistState });
  // Put a raised permission preset back once the delivered turn is over.
  bus.attach(ctx);
  if (settings.tools) registerTools(ctx, bus);
  if (settings.promptSection) {
    ctx.inject(['systemPrompt'], (scoped) => {
      scoped.systemPrompt.section({
        name: PROMPT_SECTION_NAME,
        order: PROMPT_SECTION_ORDER,
        interpolate: false,
        text: PROMPT_SECTION,
      });
    });
  }
  info(
    ctx,
    `session-bus ready (tools=${settings.tools}, promptSection=${settings.promptSection}, maxHops=${settings.maxHops}, crossWorkspace=${settings.allowCrossWorkspace}, spawn=${settings.allowSpawn})`,
  );
}

/** The configuration an operator can set, exported for documentation and tests. */
export { DEFAULT_CONFIG };

/** Log one informational line without depending on a particular logger shape. */
function info(ctx, message) {
  if (typeof ctx.logger?.info === 'function') ctx.logger.info(message);
}
