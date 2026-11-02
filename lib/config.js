/**
 * Deployment defaults and defensive normalization for session-bus config.
 *
 * The Cordis `Config` schema (declared in `lib/index.js`) validates operator
 * input; this module is the last line of defence used by the core so that a
 * missing or partial config object still yields a fully populated, bounded
 * configuration, and so the core stays testable without the plugin runtime.
 *
 * @module dsh-session-bus/config
 */

/** Every tunable of the plugin, with the value used when nothing is configured. */
export const DEFAULT_CONFIG = Object.freeze({
  /** Master switch: when false the plugin loads but contributes nothing. */
  enabled: true,
  /** Register the `bus_*` tools. */
  tools: true,
  /** Add the inter-session messaging section to the system prompt. */
  promptSection: true,
  /** Allow pushing into a Session whose working directory differs from the sender's. */
  allowCrossWorkspace: true,
  /** Allow `bus_spawn` to create new Sessions. */
  allowSpawn: true,
  /** Allow pushing into the calling Session itself. */
  allowSelf: false,
  /**
   * Maximum number of bus hops a conversation may travel before it is refused.
   *
   * One hop is one hand-off between the two sides, so a real
   * question → answer → confirmation exchange already spends three. The default
   * is sized for that working rhythm; a deliberately long collaboration can
   * raise the budget of that one thread with `bus_send({ max_hops })` instead of
   * bypassing the guard with `force` on every send.
   */
  maxHops: 16,
  /** Maximum character count of one pushed message body. */
  maxMessageChars: 20000,
  /**
   * Delivery mode used when the caller does not choose one.
   *
   * `'queue'` waits for a running turn to end, `'steer'` submits into the
   * running step unconditionally, and `'interrupt'` is the conclusion-safe
   * middle ground: inject immediately when the target is running, wake it like
   * `'queue'` when it is idle. `'inbox'` is the quiet mode: it leaves the
   * message in the target's inbox without starting a turn (`agent.inject`), so
   * an acknowledgement or closing note does not cost the peer a whole turn.
   */
  defaultMode: 'queue',
  /**
   * Whether a reply to the peer's own message is delivered as an interrupt.
   *
   * That reply is usually the conclusion the peer asked for. Queueing it behind
   * a running turn lets the peer finish work on the assumption this answer was
   * about to correct, so while the peer is running such a reply is upgraded to
   * `'interrupt'` (injected into the running step, normal wake when idle). An
   * explicit `mode` always wins. Set false to keep every unnamed mode exactly
   * as configured.
   */
  interruptReplies: true,
  /**
   * How an inbound bus message is presented in the receiving Session.
   *
   * `'notice'` (default) delivers the message through the Agent API with the
   * DSH `agent-message` source, so the Web UI renders it as a left, full-width
   * "task message received" card instead of a right-aligned bubble that looks
   * like the local user typed it. `'bubble'` keeps the pre-0.4 behavior: an
   * ordinary `user` prompt through `sessionController.prompt()`.
   */
  inboundPresentation: 'notice',
  /** Budget for admitting one prompt, in milliseconds. */
  deliveryTimeoutMs: 120000,
  /** Append one JSONL audit record per delivery under `<DSH_HOME>/session-bus`. */
  audit: true,
  /** Maximum Sessions returned by `bus_list`. */
  listLimit: 40,
  /**
   * Maximum candidates `bus_find` returns when routing a question.
   *
   * Routing is a retrieval result, not a listing: a handful of Sessions with the
   * matching snippet is enough for the calling model to pick one, and a long
   * candidate list only costs context.
   */
  findLimit: 5,
  /**
   * Permission preset a pushed-into Session is raised to.
   *
   * `'delegate'` (default) gives the target the preset the *calling* Session is
   * already running with, and never lowers the target's own preset. That is what
   * makes a delegated task actually runnable: on Windows a `workspace-write`
   * Session cannot start `pwsh` (DSH sandbox defect 0xC0000142), so waking a
   * Session in another workspace is useless unless it runs at the caller's level.
   * It never manufactures a privilege the user did not already grant the Session
   * that is delegating.
   *
   * `'inherit'` leaves the target alone; a preset name pins every target to that
   * one preset.
   */
  targetPermission: 'delegate',
  /**
   * When a body is longer than `maxMessageChars`, spool it to
   * `<DSH_HOME>/session-bus/spool/<messageId>.md` and send a short pointer
   * instead of refusing the delivery. The receiver reads the file with its own
   * file tools, so a long contract or test log neither blocks the bus nor
   * permanently occupies the receiving Session's context.
   */
  spoolLongMessages: true,
  /**
   * Restore a target Session's own permission preset once the delivered turn
   * ends and nothing else is queued for it. Raising a Session's permission to
   * run one delegated task must not become its new permanent level.
   */
  restorePermission: true,
  /**
   * Persist the thread ledger and pending permission restores to
   * `<DSH_HOME>/session-bus/state.json` so a restart keeps thread ids, hop
   * counts, and what still needs restoring. Disable for tests and throwaway hosts.
   */
  persistState: true,
  /**
   * Lifetime of a workspace write lease, in minutes.
   *
   * A lease is a short-lived claim on a set of paths that stops two Sessions in
   * the same working directory from editing the same files at the same time.
   * The default covers one editing pass; a crashed or abandoned Session cannot
   * block a workspace for longer than this because the lease expires by itself.
   */
  leaseTtlMinutes: 30,
  /** Maximum character count of one structured `payload` object, JSON-serialized. */
  maxPayloadChars: 8000,
  /** Maximum number of file attachments one message may name. */
  maxAttachments: 16,
});

/** Preset names this plugin can order by capability; anything else is `custom`. */
const PERMISSION_RANK = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 };

/** Preset names accepted by `targetPermission`. */
export const TARGET_PERMISSION_VALUES = Object.freeze(['delegate', 'inherit', ...Object.keys(PERMISSION_RANK)]);

/** Values accepted by `inboundPresentation`. */
export const INBOUND_PRESENTATION_VALUES = Object.freeze(['notice', 'bubble']);

/** Delivery modes the bus understands. */
export const MODE_VALUES = Object.freeze(['queue', 'steer', 'interrupt', 'inbox']);

/**
 * Optional message kinds.
 *
 * A kind is metadata for the receiver and for interrupt policy: only a reply
 * that is itself a `'conclusion'` or `'correction'` (or unnamed) is upgraded to
 * `'interrupt'` automatically, while `'task'`, `'notice'`, and `'ack'` stay
 * queued so a routine acknowledgement never interrupts a running turn.
 */
export const KIND_VALUES = Object.freeze(['task', 'conclusion', 'correction', 'question', 'notice', 'ack']);

/**
 * Order two permission presets by capability.
 * @param {string|undefined} name - preset name, or an unknown name such as `custom`.
 * @returns {number} 0 read-only, 1 workspace-write, 2 danger-full-access, 3 unknown.
 */
export function permissionRank(name) {
  return Object.hasOwn(PERMISSION_RANK, name ?? '') ? PERMISSION_RANK[name] : 3;
}

/**
 * Whether a preset name is one this plugin can reason about.
 * @param {string|undefined} name - preset name to test.
 * @returns {boolean} true for read-only, workspace-write, and danger-full-access.
 */
export function isKnownPreset(name) {
  return Object.hasOwn(PERMISSION_RANK, name ?? '');
}

/**
 * Normalize raw plugin config into the complete, bounded shape the core uses.
 * @param {object} [raw] - config as handed to `apply`.
 * @returns {typeof DEFAULT_CONFIG} the effective configuration.
 */
export function normalizeConfig(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {};
  return {
    enabled: boolean(value.enabled, DEFAULT_CONFIG.enabled),
    tools: boolean(value.tools, DEFAULT_CONFIG.tools),
    promptSection: boolean(value.promptSection, DEFAULT_CONFIG.promptSection),
    allowCrossWorkspace: boolean(value.allowCrossWorkspace, DEFAULT_CONFIG.allowCrossWorkspace),
    allowSpawn: boolean(value.allowSpawn, DEFAULT_CONFIG.allowSpawn),
    allowSelf: boolean(value.allowSelf, DEFAULT_CONFIG.allowSelf),
    maxHops: integer(value.maxHops, DEFAULT_CONFIG.maxHops, 1, 64),
    maxMessageChars: integer(value.maxMessageChars, DEFAULT_CONFIG.maxMessageChars, 1, 200000),
    defaultMode: MODE_VALUES.includes(value.defaultMode) ? value.defaultMode : DEFAULT_CONFIG.defaultMode,
    interruptReplies: boolean(value.interruptReplies, DEFAULT_CONFIG.interruptReplies),
    inboundPresentation: value.inboundPresentation === 'bubble' ? 'bubble' : DEFAULT_CONFIG.inboundPresentation,
    deliveryTimeoutMs: integer(value.deliveryTimeoutMs, DEFAULT_CONFIG.deliveryTimeoutMs, 1000, 900000),
    audit: boolean(value.audit, DEFAULT_CONFIG.audit),
    listLimit: integer(value.listLimit, DEFAULT_CONFIG.listLimit, 1, 200),
    findLimit: integer(value.findLimit, DEFAULT_CONFIG.findLimit, 1, 20),
    targetPermission: TARGET_PERMISSION_VALUES.includes(value.targetPermission)
      ? value.targetPermission
      : DEFAULT_CONFIG.targetPermission,
    spoolLongMessages: boolean(value.spoolLongMessages, DEFAULT_CONFIG.spoolLongMessages),
    restorePermission: boolean(value.restorePermission, DEFAULT_CONFIG.restorePermission),
    persistState: boolean(value.persistState, DEFAULT_CONFIG.persistState),
    leaseTtlMinutes: integer(value.leaseTtlMinutes, DEFAULT_CONFIG.leaseTtlMinutes, 1, 480),
    maxPayloadChars: integer(value.maxPayloadChars, DEFAULT_CONFIG.maxPayloadChars, 1, 200000),
    maxAttachments: integer(value.maxAttachments, DEFAULT_CONFIG.maxAttachments, 0, 64),
  };
}

/** Read a boolean, falling back to the default for anything else. */
function boolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** Read an integer inside `[min, max]`, falling back for anything else. */
function integer(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}
