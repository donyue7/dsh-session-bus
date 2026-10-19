/**
 * The session-bus core.
 *
 * The bus turns "push a message into another Session" into an operation the
 * DSH runtime already performs for non-human input: the target Agent is resumed
 * if it is cold, the message is admitted to its inbox (next Turn when idle, the
 * running step when steering), and its driver wakes.
 *
 * Presentation is part of the contract. By default the message carries the DSH
 * `agent-message` source, so the receiving Web UI shows it as a left, full-width
 * "task message received" card rather than a right-aligned bubble that looks
 * like the local user typed it. `inboundPresentation: 'bubble'` restores the
 * legacy path (`sessionController.prompt()` records an ordinary `user` message).
 * Either way no Session has to be paused, copied from, or pasted into by hand.
 *
 * Everything host-specific enters through the injected `ctx`, so this module
 * stays free of plugin-runtime imports and can be unit-tested with a fake host.
 *
 * @module dsh-session-bus/bus
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { renderEnvelope, parseEnvelope } from './envelope.js';
import { resolveSessionQuery, resolveWorkspaceQuery, sameWorkspace } from './resolve.js';
import { normalizeConfig, isKnownPreset, permissionRank } from './config.js';

/** Delivery modes accepted by the prompt path. */
const MODES = new Set(['queue', 'steer']);

/**
 * Source kind carried by a delivery that must not look like local typing.
 *
 * DSH declares `agent-message` for "another agent addressed this Session" and
 * the Web UI renders it as a non-human card. The producer-specific fields the
 * bus adds beside it (`busMessageId`, `threadId`, `hop`) ride in the same
 * durable source; they are what makes a retried delivery idempotent.
 */
const NOTICE_SOURCE_KIND = 'agent-message';

/** Upper bound on the event window scanned when reading a transcript tail. */
const MAX_SCAN_EVENTS = 200000;

/** Upper bound on remembered threads and messages in the persisted ledger. */
const MAX_THREADS = 400;
const MAX_MESSAGES = 1000;

/** A delivery was refused; `code` is the machine-readable reason. */
export class BusError extends Error {
  /**
   * @param {string} code - stable reason code (for example `hop_budget_exhausted`).
   * @param {string} message - human-readable explanation.
   * @param {object} [details] - extra facts for the caller and the audit record.
   */
  constructor(code, message, details = {}) {
    super(`[${code}] ${message}`);
    this.name = 'BusError';
    this.code = code;
    this.details = details;
  }
}

/**
 * The conversation ledger.
 *
 * Loop protection must count hops **per conversation**, not per Session: one
 * Session routinely talks to several peers, and a per-Session counter lets an
 * unrelated peer consume the budget of a conversation it is not part of. So a
 * thread owns the hop count, and only a hand-off to the other side increments
 * it. Naming the thread or the message it answers continues that thread; so does
 * writing again to a peer that has not answered yet. Anything else starts a new
 * thread at hop 1.
 */
export class ThreadLedger {
  /** @type {Map<string, {id: string, hop: number, participants: string[], lastMessageId: string, lastFrom: string, lastTo: string, awaitingReplyFrom: string|undefined, lastAt: number}>} */
  #threads = new Map();
  /** @type {Map<string, {threadId: string, messageId: string, from: string, hop: number, at: number}>} */
  #inbound = new Map();
  /** @type {Map<string, {threadId: string, at: number, from: string, to: string}>} */
  #messages = new Map();

  /**
   * The thread a send continues, if any.
   *
   * A send continues a thread when the caller names one (`thread`), names the
   * message it answers (`reply_to`), or is writing again to a peer that has not
   * answered yet: a follow-up belongs to the conversation it follows, never to a
   * parallel one. Anything else starts a thread of its own.
   * @param {object} input - `{senderId, targetId, replyTo, threadId}`.
   * @returns {{threadId: string, hop: number, replyTo?: string, continued: boolean}} the thread context.
   */
  next(input) {
    if (typeof input.threadId === 'string' && input.threadId !== '') {
      const known = this.#threads.get(input.threadId);
      return {
        threadId: input.threadId,
        hop: this.#hopFor(known, input.senderId),
        ...input.replyTo === undefined ? {} : { replyTo: input.replyTo },
        continued: true,
      };
    }
    if (typeof input.replyTo === 'string' && input.replyTo !== '') {
      const owner = this.#messages.get(input.replyTo)?.threadId;
      const known = owner === undefined ? undefined : this.#threads.get(owner);
      if (known !== undefined) return { threadId: known.id, hop: this.#hopFor(known, input.senderId), replyTo: input.replyTo, continued: true };
    }
    // Writing again before the peer answered: without this the second message
    // opens a parallel thread and the first one stays pending until it is pruned,
    // so a "here is one more detail" after a long body would strand the request.
    const pending = this.#pending(input.senderId, input.targetId);
    if (pending !== undefined) {
      return { threadId: pending.id, hop: this.#hopFor(pending, input.senderId), replyTo: pending.lastMessageId, continued: true };
    }
    const inbound = this.#inbound.get(input.senderId);
    // Only the peer that just wrote to us continues this conversation; sending
    // to anybody else is a new conversation with its own budget.
    if (inbound !== undefined && inbound.from === input.targetId) {
      const known = this.#threads.get(inbound.threadId);
      if (known !== undefined) return { threadId: known.id, hop: this.#hopFor(known, input.senderId), replyTo: inbound.messageId, continued: true };
    }
    return { threadId: `t-${randomUUID().replace(/-/g, '').slice(0, 12)}`, hop: 1, continued: false };
  }

  /**
   * The hop a send lands on.
   *
   * Only a hand-off to the other side costs a hop. A second message from the
   * side that already holds the turn is the same hand-off still going on, so a
   * caller pushing two updates in a row does not spend the budget that exists to
   * stop two Sessions from bouncing.
   * @param {object|undefined} thread - the thread being continued, if known.
   * @param {string} senderId - the Session sending now.
   * @returns {number} the hop number this send lands on.
   */
  #hopFor(thread, senderId) {
    if (thread === undefined || thread.lastFrom !== senderId) return (thread?.hop ?? 0) + 1;
    return thread.hop;
  }

  /**
   * The newest thread in which `peerId` still owes `selfId` an answer.
   * @param {string} selfId - the Session sending now.
   * @param {string} peerId - the Session being written to.
   * @returns {object|undefined} the pending thread, if there is one.
   */
  #pending(selfId, peerId) {
    return this.threadsOf(selfId).find((thread) => thread.awaitingReplyFrom === peerId);
  }

  /**
   * Record one delivered message on both sides of the ledger.
   * @param {object} input - `{threadId, hop, messageId, fromId, toId, at}`.
   * @returns {void}
   */
  record(input) {
    const existing = this.#threads.get(input.threadId);
    const participants = new Set(existing?.participants ?? []);
    participants.add(input.fromId);
    participants.add(input.toId);
    this.#threads.set(input.threadId, {
      id: input.threadId,
      hop: input.hop,
      participants: [...participants].slice(0, 4),
      lastMessageId: input.messageId,
      lastFrom: input.fromId,
      lastTo: input.toId,
      awaitingReplyFrom: input.toId,
      lastAt: input.at,
    });
    this.#inbound.set(input.toId, {
      threadId: input.threadId,
      messageId: input.messageId,
      from: input.fromId,
      hop: input.hop,
      at: input.at,
    });
    this.#messages.set(input.messageId, {
      threadId: input.threadId,
      at: input.at,
      from: input.fromId,
      to: input.toId,
    });
    this.#prune();
  }

  /**
   * One thread by id.
   * @param {string} threadId - thread id.
   * @returns {object|undefined} the thread record.
   */
  thread(threadId) {
    return this.#threads.get(threadId);
  }

  /**
   * When a message was sent, for `bus_read since` and thread views.
   *
   * The message table holds every message this Host delivered in either
   * direction, so an id the caller saw in an inbound envelope resolves here too,
   * not only ids the caller sent.
   * @param {string} messageId - message id.
   * @returns {{threadId: string, at: number}|undefined} the message record.
   */
  message(messageId) {
    const sent = this.#messages.get(messageId);
    if (sent !== undefined) return sent;
    // The inbox row outlives the message table when the oldest entries are
    // pruned, and it is the only record left for a message this Host received.
    for (const record of this.#inbound.values()) {
      if (record.messageId === messageId) return { threadId: record.threadId, at: record.at };
    }
    return undefined;
  }

  /**
   * Every thread one Session participates in, newest first.
   * @param {string} sessionId - Session id.
   * @returns {object[]} matching thread records.
   */
  threadsOf(sessionId) {
    return [...this.#threads.values()]
      .filter((thread) => thread.participants.includes(sessionId))
      .sort((left, right) => right.lastAt - left.lastAt);
  }

  /** Serializable snapshot of the ledger. */
  toJSON() {
    return {
      threads: [...this.#threads.values()],
      inbound: [...this.#inbound.entries()],
      messages: [...this.#messages.entries()],
    };
  }

  /**
   * Adopt a snapshot written by an earlier Host process.
   * @param {object} [data] - snapshot from {@link ThreadLedger#toJSON}.
   * @returns {void}
   */
  restore(data) {
    if (data === null || typeof data !== 'object') return;
    if (Array.isArray(data.threads)) for (const thread of data.threads) if (thread?.id !== undefined) this.#threads.set(thread.id, thread);
    if (Array.isArray(data.inbound)) for (const [key, value] of data.inbound) if (typeof key === 'string' && value !== undefined) this.#inbound.set(key, value);
    if (Array.isArray(data.messages)) for (const [key, value] of data.messages) if (typeof key === 'string' && value !== undefined) this.#messages.set(key, value);
    this.#prune();
  }

  /** Keep the ledger bounded so a long-lived Host cannot grow it forever. */
  #prune() {
    if (this.#threads.size > MAX_THREADS) {
      for (const thread of [...this.#threads.values()].sort((left, right) => left.lastAt - right.lastAt).slice(0, this.#threads.size - MAX_THREADS)) {
        this.#threads.delete(thread.id);
      }
    }
    if (this.#messages.size > MAX_MESSAGES) {
      for (const [id, record] of [...this.#messages.entries()].sort((left, right) => left[1].at - right[1].at).slice(0, this.#messages.size - MAX_MESSAGES)) {
        this.#messages.delete(id);
      }
    }
  }
}

/**
 * Owns every session-bus operation.
 */
export class SessionBus {
  /**
   * @param {object} options - construction options.
   * @param {object} options.ctx - plugin context carrying `sessionController`, `workspaceRegistry`, `sessions`.
   * @param {object} [options.config] - raw plugin config.
   * @param {{info?: Function, warn?: Function, error?: Function}} [options.logger] - host logger.
   * @param {() => number} [options.clock] - epoch-millisecond clock (tests).
   * @param {() => string} [options.idFactory] - message id factory (tests).
   * @param {boolean} [options.persist] - read and write `<DSH_HOME>/session-bus/state.json` (default true).
   */
  constructor({ ctx, config, logger, clock, idFactory, persist }) {
    /** @type {object} */
    this.ctx = ctx;
    /** @type {ReturnType<typeof normalizeConfig>} */
    this.config = normalizeConfig(config);
    this.logger = logger ?? {};
    this.clock = clock ?? (() => Date.now());
    this.idFactory = idFactory ?? (() => randomUUID().replace(/-/g, '').slice(0, 12));
    this.ledger = new ThreadLedger();
    this.auditQueue = Promise.resolve();
    /** @type {Map<string, {from: string|undefined, to: string, at: number}>} permissions this bus raised, awaiting restore. */
    this.elevated = new Map();
    this.persist = persist !== false;
    this.saveTimer = undefined;
    // Bind to the Harness home this bus was created in: a debounced write must
    // never land in whatever home the process happens to point at later.
    const home = process.env.DSH_HOME;
    this.home = typeof home === 'string' && home !== '' ? home : undefined;
    if (this.persist) this.#loadState();
  }

  /** The `sessionController` service, resolved lazily so load order never matters. */
  get sessionsApi() {
    const service = this.ctx.sessionController;
    if (service === undefined) throw new Error('session-bus: the sessionController service is unavailable in this Host');
    return service;
  }

  /** The `workspaceRegistry` service when the Host provides one. */
  get workspacesApi() {
    return this.ctx.get?.('workspaceRegistry') ?? this.ctx.workspaceRegistry;
  }

  /** The `permissionPresets` service when the Host provides one. */
  get permissionPresets() {
    return this.ctx.get?.('permissionPresets') ?? this.ctx.permissionPresets;
  }

  /** The live-Session store when the Host provides one. */
  get sessionStore() {
    return this.ctx.get?.('sessions') ?? this.ctx.sessions;
  }

  /**
   * List the Sessions this Host can see, newest activity first.
   * @param {object} [options] - listing options.
   * @param {string} [options.query] - optional case-insensitive filter over id, title, and cwd.
   * @param {boolean} [options.includeSubagents] - include subagent-owned Sessions.
   * @param {number} [options.limit] - maximum rows.
   * @param {number} [options.offset] - rows to skip, for paging past the first page.
   * @param {number} [options.updatedWithinMinutes] - keep Sessions active within this window.
   * @param {boolean} [options.activeOnly] - keep only Sessions this caller already shares a thread with.
   * @param {string} [options.selfId] - the calling Session, used to mark `isSelf`.
   * @param {string} [options.selfCwd] - the calling Session's working directory.
   * @param {AbortSignal} [options.signal] - cancellation.
   * @returns {Promise<{sessions: Array<object>, total: number, returned: number, offset: number, hasMore: boolean}>} the listing.
   */
  async list(options = {}) {
    const rows = await this.rows(options.signal);
    const includeSubagents = options.includeSubagents === true;
    const limit = clampInteger(options.limit, this.config.listLimit, 1, 200);
    const offset = clampInteger(options.offset, 0, 0, 100000);
    const needle = String(options.query ?? '').trim().toLowerCase();
    const now = this.clock();
    const within = typeof options.updatedWithinMinutes === 'number' && Number.isFinite(options.updatedWithinMinutes)
      ? now - options.updatedWithinMinutes * 60000
      : undefined;
    const known = options.activeOnly === true && typeof options.selfId === 'string'
      ? new Set(this.ledger.threadsOf(options.selfId).flatMap((thread) => thread.participants))
      : undefined;
    const visible = rows
      .filter((row) => includeSubagents || row.targetable)
      .filter((row) => needle === '' || row.searchText.includes(needle))
      .filter((row) => within === undefined || row.updatedAt >= within)
      .filter((row) => known === undefined || known.has(row.sessionId))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const page = visible.slice(offset, offset + limit);
    return {
      total: visible.length,
      offset,
      returned: page.length,
      hasMore: offset + page.length < visible.length,
      sessions: page.map((row) => ({
        sessionId: row.sessionId,
        title: row.title ?? null,
        cwd: row.cwd ?? null,
        running: row.running,
        agentAvailable: row.agentAvailable,
        busy: row.running,
        isSelf: row.sessionId === options.selfId,
        isSubagent: row.isSubagent,
        targetable: row.targetable,
        // Two Sessions editing one working directory is the failure the bus can
        // see and the caller cannot: say so before work is pushed into it.
        sameCwdAsCaller: options.selfCwd !== undefined && sameWorkspace(row.cwd, options.selfCwd),
        updatedAt: row.updatedAt,
        updatedAtIso: new Date(row.updatedAt).toISOString(),
      })),
    };
  }

  /**
   * Resolve one target reference, or explain why it cannot be resolved.
   * @param {string} reference - id, id prefix, title, cwd, or `self`.
   * @param {object} [options] - options.
   * @param {string} [options.selfId] - the calling Session.
   * @param {boolean} [options.allowSelf] - whether the caller may target itself.
   * @param {AbortSignal} [options.signal] - cancellation.
   * @returns {Promise<object>} the normalized target row.
   */
  async resolveTarget(reference, options = {}) {
    const rows = await this.rows(options.signal);
    const outcome = resolveSessionQuery(rows, reference, {
      selfId: options.selfId,
      allowSelf: options.allowSelf ?? this.config.allowSelf,
    });
    if (outcome.ok) return outcome.row;
    const candidates = outcome.candidates.length === 0
      ? ''
      : ` Candidates: ${outcome.candidates.map(formatCandidate).join('; ')}`;
    throw new Error(`${outcome.message}.${candidates}`);
  }

  /**
   * Push one message into another Session.
   * @param {object} input - send request.
   * @param {string} input.to - target reference.
   * @param {string} input.message - message body.
   * @param {'queue'|'steer'} [input.mode] - delivery mode.
   * @param {boolean} [input.force] - bypass the hop budget for this delivery.
   * @param {object} input.sender - `{id, title, cwd}` of the calling Session.
   * @param {AbortSignal} [input.signal] - cancellation.
   * @returns {Promise<object>} the delivery receipt.
   */
  async send(input) {
    const target = await this.resolveTarget(input.to, {
      selfId: input.sender?.id,
      signal: input.signal,
    });
    return this.deliver({ ...input, target });
  }

  /**
   * Create a new Session and push the first message into it.
   * @param {object} input - spawn request.
   * @param {string} input.message - first message body.
   * @param {string} [input.workspace] - registered workspace path, id, or title.
   * @param {string} [input.cwd] - working directory when no workspace is named.
   * @param {string} [input.preset] - agent preset for the new Session.
   * @param {'queue'|'steer'} [input.mode] - delivery mode.
   * @param {string} [input.spawnKey] - idempotency key: the same key always resolves to one Session.
   * @param {object} input.sender - `{id, title, cwd}` of the calling Session.
   * @param {AbortSignal} [input.signal] - cancellation.
   * @returns {Promise<object>} the delivery receipt, including the new Session id.
   */
  async spawn(input) {
    if (!this.config.allowSpawn) {
      this.#reject('spawn_disabled', 'bus_spawn is disabled by this deployment (allowSpawn: false)', {
        from: input.sender?.id ?? null,
        to: null,
      });
    }
    const workspace = await this.#resolveSpawnWorkspace(input);
    // A retried spawn must adopt the Session the first attempt created rather
    // than leaving a second one behind: the id is derived from the caller's key.
    const key = typeof input.spawnKey === 'string' && input.spawnKey.trim() !== '' ? input.spawnKey.trim() : undefined;
    const requestedId = key === undefined
      ? undefined
      : `session-bus-${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
    let reused = false;
    if (requestedId !== undefined) {
      try {
        await this.sessionsApi.inspect(requestedId, input.signal);
        reused = true;
      } catch {
        reused = false;
      }
    }
    const request = {
      ...workspace.id === undefined ? { cwd: workspace.cwd } : { workspaceId: workspace.id },
      ...input.preset === undefined ? {} : { agentPreset: input.preset },
      ...requestedId === undefined ? {} : { sessionId: requestedId },
    };
    const created = await this.sessionsApi.create(request);
    const sessionId = String(created?.sessionId ?? requestedId ?? '');
    if (sessionId === '') {
      this.#reject('spawn_failed', 'the Host did not return an id for the new Session', { from: input.sender?.id ?? null, to: null });
    }
    return this.deliver({
      ...input,
      target: {
        sessionId,
        title: undefined,
        cwd: workspace.cwd,
        running: false,
        agentAvailable: true,
        targetable: true,
        isSubagent: false,
        updatedAt: this.clock(),
        searchText: '',
      },
      crossWorkspaceAllowed: true,
      created: !reused,
    });
  }

  /**
   * Read the recent transcript of one Session.
   * @param {object} input - read request.
   * @param {string} input.session - target reference (id, prefix, title, cwd, `self`).
   * @param {number} [input.limit] - maximum messages returned.
   * @param {number} [input.maxChars] - approximate character budget for the returned text.
   * @param {object} input.sender - `{id, title, cwd}` of the calling Session.
   * @param {AbortSignal} [input.signal] - cancellation.
   * @returns {Promise<object>} the transcript tail.
   */
  async read(input) {
    const target = await this.resolveTarget(input.session, {
      selfId: input.sender?.id,
      allowSelf: true,
      signal: input.signal,
    });
    const limit = clampInteger(input.limit, 12, 1, 100);
    const maxChars = clampInteger(input.maxChars, 8000, 200, 100000);
    const sinceAt = this.#resolveSince(input.since);
    const inspection = await this.sessionsApi.inspect(target.sessionId, input.signal);
    const events = Array.isArray(inspection?.events) ? inspection.events : [];
    const window = events.length > MAX_SCAN_EVENTS ? events.slice(events.length - MAX_SCAN_EVENTS) : events;
    const title = titleOf(window) ?? target.title ?? null;
    const messages = [];
    let chars = 0;
    for (let index = window.length - 1; index >= 0 && messages.length < limit; index -= 1) {
      const entry = toTranscriptEntry(window[index]);
      if (entry === undefined) continue;
      // The window is scanned newest-first, so the first older entry ends the
      // incremental read.
      if (sinceAt !== undefined && entry.time <= sinceAt) break;
      if (chars + entry.text.length > maxChars && messages.length > 0) break;
      chars += entry.text.length;
      messages.push(entry);
    }
    messages.reverse();
    return {
      sessionId: target.sessionId,
      title,
      cwd: target.cwd ?? null,
      running: target.running,
      agentAvailable: target.agentAvailable,
      since: sinceAt === undefined ? null : new Date(sinceAt).toISOString(),
      returned: messages.length,
      totalEvents: events.length,
      truncated: messages.length < countMessages(window) || chars >= maxChars,
      messages: messages.map((entry) => ({
        role: entry.role,
        at: new Date(entry.time).toISOString(),
        viaBus: entry.viaBus === true,
        text: entry.text,
      })),
    };
  }

  /**
   * Admit one bus message into an already-resolved target.
   * @param {object} input - delivery request.
   * @returns {Promise<object>} the delivery receipt.
   */
  async deliver(input) {
    const { target, sender } = input;
    const mode = MODES.has(input.mode) ? input.mode : this.config.defaultMode;
    const body = typeof input.message === 'string' ? input.message : '';
    const crossWorkspace = !sameWorkspace(target.cwd, sender?.cwd);
    const scopes = normalizeScopes(input.writeScopes);
    /** Every refusal is audited and carries a stable code. */
    const reject = (code, message, details = {}) => this.#reject(code, message, {
      from: sender?.id ?? null,
      to: target.sessionId,
      mode,
      chars: body.length,
      crossWorkspace,
      ...details,
    });

    if (typeof sender?.id !== 'string' || sender.id === '') {
      reject('no_sender', 'a pushed message needs a calling Session so the receiver can answer');
    }
    if (body.trim() === '') reject('empty_message', 'the message must contain non-whitespace text');
    const spoolDir = this.config.spoolLongMessages ? this.#spoolDir() : undefined;
    const needsSpool = body.length > this.config.maxMessageChars;
    if (needsSpool && spoolDir === undefined) {
      reject(
        'message_too_long',
        `the message is ${body.length} characters, above the configured limit of ${this.config.maxMessageChars} and spooling is unavailable`,
        { limit: this.config.maxMessageChars },
      );
    }
    if (target.sessionId === sender.id && !this.config.allowSelf && input.force !== true) {
      reject('self_send_disabled', 'sending to your own Session is disabled (allowSelf: false); use bus_spawn to start a new Session instead');
    }
    if (crossWorkspace && !this.config.allowCrossWorkspace && input.crossWorkspaceAllowed !== true) {
      reject(
        'cross_workspace_disabled',
        `cross-workspace delivery is disabled (allowCrossWorkspace: false); "${target.sessionId}" works in ${target.cwd ?? '(unknown)'}`,
      );
    }

    // The hop budget belongs to the conversation, not to either Session: sending
    // to a peer that never wrote to us starts a fresh thread at hop 1, so one
    // busy conversation can never exhaust another one's budget.
    const thread = this.ledger.next({
      senderId: sender.id,
      targetId: target.sessionId,
      replyTo: typeof input.replyTo === 'string' ? input.replyTo : undefined,
      threadId: typeof input.threadId === 'string' ? input.threadId : undefined,
    });
    if (thread.hop > this.config.maxHops && input.force !== true) {
      reject(
        'hop_budget_exhausted',
        `thread ${thread.threadId} is at hop ${thread.hop}, above maxHops=${this.config.maxHops}; these Sessions look like they are bouncing. Send a final answer to the user, or pass force: true to continue deliberately.`,
        { threadId: thread.threadId, hop: thread.hop, maxHops: this.config.maxHops },
      );
    }

    const messageId = this.idFactory();
    const at = this.clock();
    const time = new Date(at).toISOString();
    const spooled = needsSpool ? await this.#spool(messageId, body) : undefined;
    if (needsSpool && spooled === undefined) {
      reject('message_too_long', `the message is ${body.length} characters and could not be spooled`, {
        limit: this.config.maxMessageChars,
      });
    }
    const text = renderEnvelope({
      fromId: sender.id,
      fromTitle: sender.title,
      fromCwd: sender.cwd,
      hop: thread.hop,
      maxHops: this.config.maxHops,
      messageId,
      replyTo: thread.replyTo,
      threadId: thread.threadId,
      time,
      writeScopes: scopes,
      bodyFile: spooled?.path,
      bodyBytes: spooled?.bytes,
      text: spooled === undefined
        ? body
        : `(long message: ${body.length} characters stored at ${spooled.path} — read that file before answering)`,
    });

    const timeZone = safeTimeZone();
    // Raise the target to the caller's permission level before the task lands.
    // A pushed task the target cannot run — a Windows Session that cannot start
    // pwsh under workspace-write — is the failure this prevents.
    const permission = input.elevate === false
      ? { skipped: true }
      : await this.#applyTargetPermission(target.sessionId, sender, input.signal);
    const admitted = permissionApplied(permission) ? injectPermissionNotice(text, permission.applied) : text;
    try {
      await this.#admit({
        target,
        sender,
        text: admitted,
        mode,
        messageId,
        thread,
        timeZone,
        signal: input.signal,
      });
    } catch (error) {
      // Nothing was delivered, so the permission change made for it is undone:
      // a refused delivery must leave no trace on the target.
      const restored = await this.#restorePermission(target.sessionId);
      const detail = error instanceof Error ? error.message : String(error);
      this.#reject('delivery_failed', `delivery to "${target.sessionId}" failed: ${detail}`, {
        threadId: thread.threadId,
        hop: thread.hop,
        permissionRestored: restored,
      });
    }

    this.ledger.record({
      threadId: thread.threadId,
      hop: thread.hop,
      messageId,
      fromId: sender.id,
      toId: target.sessionId,
      at,
    });
    this.#scheduleSave();
    void this.#audit({
      event: 'deliver',
      messageId,
      threadId: thread.threadId,
      replyTo: thread.replyTo ?? null,
      from: sender.id,
      fromCwd: sender.cwd ?? null,
      to: target.sessionId,
      toCwd: target.cwd ?? null,
      mode,
      hop: thread.hop,
      chars: body.length,
      presentation: this.config.inboundPresentation,
      writeScopes: scopes,
      spooled: spooled !== undefined,
      created: input.created === true,
      crossWorkspace,
      permission: permission.applied ?? permission.current ?? null,
      permissionApplied: permissionApplied(permission),
      permissionError: permission.error ?? null,
      time,
    });

    return {
      delivered: true,
      sessionId: target.sessionId,
      title: target.title ?? null,
      cwd: target.cwd ?? null,
      mode,
      messageId,
      threadId: thread.threadId,
      ...thread.replyTo === undefined ? {} : { replyTo: thread.replyTo },
      hop: thread.hop,
      hopBudget: this.config.maxHops,
      hopRemaining: Math.max(0, this.config.maxHops - thread.hop),
      targetRunning: target.running === true,
      crossWorkspace,
      created: input.created === true,
      permission: permission.applied ?? permission.current ?? undefined,
      spooled: spooled !== undefined,
      note: deliverNote(target, permission, { sameWorkspace: !crossWorkspace, scopes, mode }),
    };
  }

  /**
   * Admit one delivery into the target, choosing the presentation its transcript
   * should use.
   *
   * `inboundPresentation: 'notice'` (the default) hands the message to the live
   * Agent with an `agent-message` source. That source is what tells the Web UI
   * the text was not typed by the person sitting at this Session, so it renders
   * as a left, full-width "task message received" card instead of the
   * right-aligned user bubble. DSH's own schedule, tool-jobs, subagent, and
   * Agent Teams plugins deliver plugin-sourced messages through the same Agent
   * API. A Host without that API (or an operator who set `bubble`) keeps the
   * legacy prompt path, which records an ordinary `user` message.
   *
   * @param {object} input - admission request.
   * @param {object} input.target - resolved target row.
   * @param {object} input.sender - `{id, title, cwd}` of the calling Session.
   * @param {string} input.text - rendered envelope, permission notice included.
   * @param {'queue'|'steer'} input.mode - delivery mode.
   * @param {string} input.messageId - bus message identity (also the retry key).
   * @param {object} input.thread - thread ledger context.
   * @param {string|undefined} input.timeZone - client time zone for the prompt path.
   * @param {AbortSignal} [input.signal] - cancellation.
   * @returns {Promise<void>} resolves once the target accepted the message.
   */
  async #admit(input) {
    if (this.config.inboundPresentation === 'notice' && await this.#admitAsNotice(input)) return;
    await this.#admitAsPrompt(input);
  }

  /**
   * Admit one message through the Agent API with a non-user source.
   *
   * The `agent-message` + `form: 'relay'` pair is the vocabulary DSH declares
   * for "another agent addressed this Session": the Client renders a non-human
   * notification and names the sending Session. The bus message id travels in
   * the durable source, so a retry after a transport failure can be recognised
   * in the target's own inbox or log instead of double-posting.
   *
   * @param {object} input - admission request; see {@link SessionBus#admit}.
   * @returns {Promise<boolean>} false when this Host cannot do agent-sourced delivery.
   */
  async #admitAsNotice(input) {
    const controller = this.sessionsApi;
    if (typeof controller.resolveAgent !== 'function') return false;
    input.signal?.throwIfAborted?.();
    const resolved = await controller.resolveAgent(input.target.sessionId);
    if (resolved === null || typeof resolved !== 'object') return false;
    if ('error' in resolved && resolved.error !== undefined) throw resolved.error;
    const agent = resolved.agent;
    if (agent === undefined || agent === null || typeof agent.followup !== 'function') return false;
    if (this.#alreadyAdmitted(agent, input.messageId)) return true;
    const message = createInboundMessage({
      text: input.text,
      source: {
        kind: NOTICE_SOURCE_KIND,
        form: 'relay',
        senderSessionId: input.sender.id,
        busMessageId: input.messageId,
        threadId: input.thread.threadId,
        hop: input.thread.hop,
      },
    });
    // followup() queues a next-Turn prompt and wakes the driver; steer() submits
    // into the running step. Both append the message and its inbox splice to the
    // Session synchronously; only durability is left for the flush below.
    if (input.mode === 'steer') agent.steer(message);
    else agent.followup(message);
    await this.#flushTarget(agent);
    return true;
  }

  /**
   * Admit one message as an ordinary `user` prompt (the pre-0.4 presentation).
   * @param {object} input - admission request; see {@link SessionBus#admit}.
   * @returns {Promise<void>} resolves once the Host accepts the prompt.
   */
  async #admitAsPrompt(input) {
    await this.sessionsApi.prompt(
      {
        requestId: `session-bus:${input.messageId}`,
        sessionId: input.target.sessionId,
        mode: input.mode,
        content: [{ type: 'text', text: input.text }],
        ...input.timeZone === undefined ? {} : { clientTimeZone: input.timeZone },
      },
      input.signal,
    );
  }

  /**
   * Whether this exact bus message already sits in the target's inbox or log.
   * @param {object} agent - live target Agent.
   * @param {string} messageId - bus message id.
   * @returns {boolean} true when the delivery already landed.
   */
  #alreadyAdmitted(agent, messageId) {
    const matches = (message) => {
      const source = message?.source;
      return source !== null && typeof source === 'object' && !Array.isArray(source) && source.busMessageId === messageId;
    };
    const inbox = agent.inbox;
    if (inbox !== null && typeof inbox === 'object') {
      if (Array.isArray(inbox.nextTurn) && inbox.nextTurn.some(matches)) return true;
      if (Array.isArray(inbox.nextStep) && inbox.nextStep.some(matches)) return true;
    }
    const session = agent.session;
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined;
    if (!Array.isArray(events)) return false;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type === 'user/message' && matches(event.data)) return true;
    }
    return false;
  }

  /**
   * Persist the target Session's buffered events, the inbox splice included.
   *
   * Durability is best-effort: the message is already admitted to the live
   * Agent, so failing the delivery after this point would report a failure the
   * target cannot undo and leave the caller retrying a message that already
   * landed. A failed flush is logged, not thrown.
   * @param {object} agent - live target Agent.
   * @returns {Promise<void>} resolves after the flush attempt.
   */
  async #flushTarget(agent) {
    const store = this.sessionStore;
    if (store === undefined || typeof store.flush !== 'function' || agent.session === undefined) return;
    try {
      await store.flush(agent.session);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (typeof this.logger.warn === 'function') {
        this.logger.warn(`session-bus: delivered to "${agent.id}" but the Session flush failed: ${detail}`);
      }
    }
  }

  /**
   * Audit one refusal, then throw it as a coded error.
   * @param {string} code - stable reason code.
   * @param {string} message - human-readable explanation.
   * @param {object} context - facts recorded in the audit record.
   * @returns {never} always throws.
   */
  #reject(code, message, context) {
    void this.#audit({ event: 'reject', code, ...context, time: new Date(this.clock()).toISOString() });
    throw new BusError(code, message, context);
  }

  /**
   * Raise the target Session's permission preset to the configured level.
   *
   * Never fails a delivery: a target that cannot be re-configured still receives
   * the message, and the receipt reports what happened.
   * @param {string} sessionId - target Session id.
   * @param {object|undefined} sender - `{id, title, cwd}` of the calling Session.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{applied?: string, current?: string, error?: string}>} what changed.
   */
  async #applyTargetPermission(sessionId, sender, signal) {
    const mode = this.config.targetPermission;
    if (mode === 'inherit') return {};
    const presets = this.permissionPresets;
    if (presets === undefined || typeof presets.set !== 'function') return {};
    try {
      const target = await this.#liveSession(sessionId, signal);
      if (target === undefined) return {};
      const current = safePresetName(presets, target);
      let desired;
      if (mode === 'delegate') {
        const senderSession = this.sessionStore?.get?.(sender?.id);
        // Without a live caller there is no level to delegate; leave the target as is.
        if (senderSession === undefined) return { current };
        desired = safePresetName(presets, senderSession);
        // A caller on a hand-tuned `custom` bundle has no preset to hand on.
        if (desired === undefined || !isKnownPreset(desired)) return { current };
        // Delegation only ever raises: a target the user deliberately confined
        // stays confined. An unreadable target preset is no constraint at all —
        // a brand-new Session has no logged override yet.
        if (current !== undefined && permissionRank(current) >= permissionRank(desired)) return { current };
      } else {
        // A pinned preset is an explicit operator decision, applied as such.
        desired = mode;
      }
      if (current === desired) return { current };
      presets.set(target, desired);
      // Remember what to put back: a raise is for one delegated task, not a new
      // permanent level for that Session.
      this.elevated.set(sessionId, { from: current, to: desired, at: this.clock() });
      this.#scheduleSave();
      if (typeof this.logger.info === 'function') {
        this.logger.info(`session-bus: raised "${sessionId}" permission to ${desired} for a delegated message`);
      }
      return { applied: desired, current };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (typeof this.logger.warn === 'function') {
        this.logger.warn(`session-bus: could not raise the permission of "${sessionId}": ${detail}`);
      }
      return { error: detail };
    }
  }

  /**
   * Resolve the live Session object for an id, resuming its Agent when cold.
   * @param {string} sessionId - Session id.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object|undefined>} the live Session, or `undefined`.
   */
  async #liveSession(sessionId, signal) {
    const attached = this.sessionStore?.get?.(sessionId);
    if (attached !== undefined) return attached;
    if (typeof this.sessionsApi.resolveAgent !== 'function') return undefined;
    const found = await this.sessionsApi.resolveAgent(sessionId);
    if (found === undefined || found === null) return undefined;
    if (typeof found !== 'object') return undefined;
    if ('error' in found) throw found.error;
    // `resolveAgent` answers with a live Agent, or with `{agent}` for one it resumed.
    return found.session ?? found.agent?.session;
  }

  /**
   * Resolve a `since` reference for incremental reads.
   * @param {string|number|undefined} since - bus message id, ISO timestamp, or epoch ms.
   * @returns {number|undefined} epoch milliseconds, or `undefined` for a full read.
   */
  #resolveSince(since) {
    if (since === undefined || since === null) return undefined;
    if (typeof since === 'number' && Number.isFinite(since)) return since;
    if (typeof since !== 'string' || since.trim() === '') return undefined;
    const text = since.trim();
    // A message id is the most precise reference the model has: it is what the
    // envelope printed, and the ledger already knows when it was sent.
    const known = this.ledger.message(text);
    if (known !== undefined) return known.at;
    const parsed = Date.parse(text);
    if (Number.isNaN(parsed)) {
      throw new BusError('invalid_since', `"${text}" is neither a known bus message id nor a date the Host can parse`);
    }
    return parsed;
  }

  /**
   * The Harness home this bus was created in.
   *
   * Captured once at construction rather than read per call: a debounced write
   * scheduled here must land in the home that owned it, never in whatever home
   * the process points at by the time the timer fires.
   * @returns {string|undefined} absolute home path, or undefined when unset.
   */
  #home() {
    return this.home;
  }

  /** Directory that spooled long bodies are written to. */
  #spoolDir() {
    const home = this.#home();
    return home === undefined ? undefined : join(home, 'session-bus', 'spool');
  }

  /**
   * Write an over-limit body to disk and describe it for the envelope.
   * @param {string} messageId - message id, used as the file name.
   * @param {string} body - the full body.
   * @returns {Promise<{path: string, bytes: number}|undefined>} the spool descriptor.
   */
  async #spool(messageId, body) {
    const dir = this.#spoolDir();
    if (dir === undefined) return undefined;
    try {
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${messageId}.md`);
      await writeFile(path, body, 'utf8');
      return { path, bytes: Buffer.byteLength(body, 'utf8') };
    } catch (error) {
      if (typeof this.logger.warn === 'function') {
        this.logger.warn(`session-bus: could not spool a long message: ${String(error)}`);
      }
      return undefined;
    }
  }

  /** Load the persisted thread ledger and pending permission restores. */
  #loadState() {
    const home = this.#home();
    if (home === undefined) return;
    const file = join(home, 'session-bus', 'state.json');
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      this.ledger.restore(data?.ledger);
      if (Array.isArray(data?.elevated)) {
        for (const entry of data.elevated) {
          if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] !== null && typeof entry[1] === 'object') {
            this.elevated.set(entry[0], entry[1]);
          }
        }
      }
    } catch {
      // No state file yet, or it is unreadable: start with an empty ledger.
    }
  }

  /** Persist the ledger after a short delay, so a burst of sends writes once. */
  #scheduleSave() {
    if (!this.persist || this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.#saveState();
    }, 500);
    if (typeof this.saveTimer?.unref === 'function') this.saveTimer.unref();
  }

  /** Write the ledger atomically; a failure never affects a delivery. */
  async #saveState() {
    const home = this.#home();
    if (home === undefined) return;
    try {
      const dir = join(home, 'session-bus');
      await mkdir(dir, { recursive: true });
      const file = join(dir, 'state.json');
      const temp = `${file}.tmp`;
      await writeFile(temp, JSON.stringify({
        version: 1,
        ledger: this.ledger.toJSON(),
        elevated: [...this.elevated.entries()],
      }), 'utf8');
      await rename(temp, file);
    } catch (error) {
      if (typeof this.logger.warn === 'function') {
        this.logger.warn(`session-bus: could not persist the thread ledger: ${String(error)}`);
      }
    }
  }

  /**
   * Register the Session-event hook that puts an elevated Session back on its own
   * permission preset once the delivered turn is over.
   * @param {object} ctx - plugin context carrying `on`.
   * @returns {void}
   */
  attach(ctx) {
    if (typeof ctx?.on !== 'function') return;
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end') return;
      if (!this.elevated.has(session.id)) return;
      void this.#restorePermission(session.id, { idleOnly: true });
    });
  }

  /**
   * Put a Session back on the preset it had before the bus raised it.
   *
   * Called both after a delivered turn ends (auto-restore, config-gated) and
   * after a failed delivery (always, because nothing was delivered). A preset the
   * user changed in the meantime is left alone.
   * @param {string} sessionId - Session to restore.
   * @param {object} [options] - `idleOnly` skips a Session that is still busy.
   * @returns {Promise<boolean>} whether a preset was written back.
   */
  async #restorePermission(sessionId, options = {}) {
    const record = this.elevated.get(sessionId);
    if (record === undefined) return false;
    if (options.idleOnly === true) {
      if (!this.config.restorePermission) {
        this.#forget(sessionId);
        return false;
      }
      const agent = this.ctx.agents?.get?.(sessionId);
      if (agent?.status === 'running') return false;
      const inbox = agent?.inbox;
      const queued = (inbox?.nextTurn?.length ?? 0) + (inbox?.nextStep?.length ?? 0);
      // Another bus message is still waiting: keep the level it needs.
      if (queued > 0) return false;
    }
    const presets = this.permissionPresets;
    if (presets === undefined || typeof record.from !== 'string') {
      this.#forget(sessionId);
      return false;
    }
    // The debt outlives a failed attempt. Dropping the record first would mean a
    // refused delivery whose rollback failed leaves the Session raised with
    // nothing left to put it back — the one case where a refusal does change the
    // target. So the record goes only once the preset really moved back, or once
    // something else settled it for good.
    const session = await this.#liveSession(sessionId).catch(() => undefined);
    if (session === undefined) return false;
    // A preset changed since the raise is the user's decision, not ours to undo:
    // that choice is the new baseline, so the debt is settled rather than pending.
    if (safePresetName(presets, session) !== record.to) {
      this.#forget(sessionId);
      return false;
    }
    try {
      presets.set(session, record.from);
    } catch {
      return false;
    }
    this.#forget(sessionId);
    void this.#audit({
      event: 'permission_restore',
      sessionId,
      from: record.to,
      to: record.from,
      time: new Date(this.clock()).toISOString(),
    });
    if (typeof this.logger.info === 'function') {
      this.logger.info(`session-bus: restored "${sessionId}" permission to ${record.from}`);
    }
    return true;
  }

  /**
   * Drop a permission debt that is paid or settled for good.
   * @param {string} sessionId - Session whose record is no longer pending.
   * @returns {void}
   */
  #forget(sessionId) {
    this.elevated.delete(sessionId);
    this.#scheduleSave();
  }

  /**
   * The conversations one Session participates in, and what each is waiting on.
   * @param {object} input - `{sender, limit}`.
   * @returns {{threads: object[], total: number}} newest thread first.
   */
  threads(input) {
    const limit = clampInteger(input?.limit, 20, 1, 100);
    const selfId = input?.sender?.id;
    const all = typeof selfId === 'string' ? this.ledger.threadsOf(selfId) : [];
    return {
      total: all.length,
      threads: all.slice(0, limit).map((thread) => {
        const peer = thread.participants.find((id) => id !== selfId) ?? null;
        return {
          threadId: thread.id,
          peer,
          hop: thread.hop,
          hopBudget: this.config.maxHops,
          hopRemaining: Math.max(0, this.config.maxHops - thread.hop),
          lastMessageId: thread.lastMessageId,
          lastAt: new Date(thread.lastAt).toISOString(),
          awaitingReplyFrom: thread.awaitingReplyFrom ?? null,
          // `pending` means this Session sent the last message and its peer has
          // not answered in this thread yet.
          pending: peer !== null && thread.awaitingReplyFrom === peer,
          awaitingYou: thread.awaitingReplyFrom === selfId,
        };
      }),
    };
  }

  /**
   * Find the Sessions whose conversations actually discuss a question.
   *
   * Routing a question to the right Session is a retrieval problem, not an
   * orchestration one: the Host indexes every Session's text, so the candidate
   * list is computed from what was really said — never from a title alone, and
   * never from a coordinator Session that would have to be kept warm and would
   * still know less than the index. Read-only: nothing here wakes a Session.
   *
   * @param {object} input - search request.
   * @param {string} input.question - what the caller needs answered.
   * @param {number} [input.limit] - maximum candidates.
   * @param {object} [input.sender] - `{id, cwd}` of the calling Session.
   * @param {AbortSignal} [input.signal] - cancellation.
   * @returns {Promise<object>} ranked candidates plus how they were found.
   */
  async find(input) {
    const question = typeof input?.question === 'string' ? input.question.trim() : '';
    if (question === '') {
      throw new BusError('empty_query', 'bus_find needs a question to search the Session corpus for');
    }
    const limit = clampInteger(input.limit, this.config.findLimit, 1, 20);
    const sender = input.sender ?? {};
    const selfId = typeof sender.id === 'string' ? sender.id : undefined;
    const selfCwd = typeof sender.cwd === 'string' ? sender.cwd : undefined;
    const rows = await this.rows(input.signal);
    const byId = new Map(rows.map((row) => [row.sessionId, row]));
    const threadOf = new Map();
    if (selfId !== undefined) {
      for (const thread of this.ledger.threadsOf(selfId)) {
        const peer = thread.participants.find((id) => id !== selfId);
        if (peer !== undefined) threadOf.set(peer, thread);
      }
    }
    // Full-text search is an optional Host capability: the plugin must keep
    // working on a Host that does not mount the session-query backend.
    const provider = this.ctx.get?.('sessionQuery');
    const searchable = provider !== undefined && typeof provider.searchSessions === 'function';
    let indexed = searchable;
    let hits = [];
    if (searchable) {
      try {
        const page = await provider.searchSessions(
          { query: question, limit: Math.min(Math.max(limit * 3, 12), 60) },
          { signal: input.signal },
        );
        hits = Array.isArray(page?.items) ? page.items : [];
      } catch (error) {
        indexed = false;
        if (typeof this.logger.warn === 'function') {
          const detail = error instanceof Error ? error.message : String(error);
          this.logger.warn(`session-bus: content search unavailable, falling back to metadata: ${detail}`);
        }
      }
    }
    const candidates = [];
    const seen = new Set();
    let matches = 0;
    for (const hit of hits) {
      const sessionId = hit?.header?.id;
      if (typeof sessionId !== 'string' || sessionId === selfId || seen.has(sessionId)) continue;
      const row = byId.get(sessionId);
      // Only Sessions the bus can actually address are useful as a routing target.
      if (row === undefined || row.targetable !== true) continue;
      seen.add(sessionId);
      matches += 1;
      if (candidates.length >= limit) continue;
      const match = hit.bestMatch ?? {};
      const matchedType = typeof match.type === 'string' ? match.type : undefined;
      candidates.push({
        sessionId,
        title: row.title,
        cwd: row.cwd,
        busy: row.running === true,
        live: hit.live === true,
        sameWorkspace: sameWorkspace(row.cwd, selfCwd),
        hasThread: threadOf.has(sessionId),
        snippet: cleanSnippet(match.snippet),
        matchedAt: typeof match.time === 'number' ? new Date(match.time).toISOString() : undefined,
        matchedType,
        why: matchedType === undefined ? '对话内容命中' : `对话内容命中（${matchedType}）`,
      });
    }
    let fallbackUsed = false;
    if (candidates.length === 0) {
      fallbackUsed = true;
      // No search backend, or nothing matched in content: rank what the metadata
      // can tell us so the caller still gets a shortlist instead of a dead end.
      const words = questionWords(question);
      const ranked = rows
        .filter((row) => row.sessionId !== selfId && row.targetable === true)
        .map((row) => ({ row, score: metadataScore(row, words) }))
        .sort((left, right) => right.score - left.score || right.row.updatedAt - left.row.updatedAt)
        .slice(0, limit);
      for (const entry of ranked) {
        candidates.push({
          sessionId: entry.row.sessionId,
          title: entry.row.title,
          cwd: entry.row.cwd,
          busy: entry.row.running === true,
          live: entry.row.agentAvailable === true,
          sameWorkspace: sameWorkspace(entry.row.cwd, selfCwd),
          hasThread: threadOf.has(entry.row.sessionId),
          why: entry.score > 0 ? '标题或工作目录命中' : '最近活跃（内容检索不可用）',
        });
      }
    }
    // Routing certainty is reported, never assumed. A single content match is a
    // clear answer; several matches, a metadata-only guess, or no match at all
    // are the caller's cue to put the choice in front of the user instead of
    // picking a Session (or creating one) on their own.
    const sure = indexed === true && fallbackUsed === false && matches === 1;
    const ambiguous = sure === false;
    let nextStep;
    if (candidates.length === 0) {
      nextStep = '没有可投递的候选：把问题交给用户确认该问哪个会话；不要自己挑一个，也不要 bus_spawn 新建会话。';
    } else if (indexed === true && fallbackUsed === true) {
      nextStep = '没有会话的对话真正讨论过这个问题，候选只是元数据猜测：把问题交给用户确认该问谁；不要自己挑，也不要 bus_spawn 新建会话。';
    } else if (indexed === false) {
      nextStep = '全文索引不可用，候选只按元数据排序：先用 bus_read 确认，或直接把选择交给用户；不要自己挑，也不要 bus_spawn 新建会话。';
    } else if (matches > 1 || candidates.length > 1) {
      nextStep = '有多个同等可能的候选：把候选连同命中片段交给用户选，不要自己决定问哪个。';
    } else {
      nextStep = '唯一明确候选：确认片段与问题对得上再 bus_send；对不上或不确定就问用户。';
    }
    return {
      query: question,
      indexed,
      searched: rows.length,
      returned: candidates.length,
      candidates,
      ambiguous,
      nextStep,
      note: indexed
        ? '命中来自会话对话内容的全文索引；读取不会唤醒任何会话，确认后用 bus_send 提问。'
        : '全文索引不可用，候选按标题/工作目录/最近活跃度排序；建议先用 bus_read 确认再提问。',
    };
  }

  /** Normalize every visible Session into the row shape used by resolution and listing. */
  async rows(signal) {
    const result = await this.sessionsApi.list({}, signal);
    const items = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : [];
    return items
      .filter((item) => item !== null && typeof item === 'object' && typeof item.sessionId === 'string')
      .map((item) => {
        const title = item.projections?.values?.title;
        const row = {
          sessionId: item.sessionId,
          title: typeof title === 'string' && title.length > 0 ? title : undefined,
          cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
          running: item.running === true,
          agentAvailable: item.agentAvailable === true,
          blank: item.blank === true,
          parentSessionId: typeof item.parentSessionId === 'string' ? item.parentSessionId : undefined,
          origin: item.origin,
          isSubagent: item.origin === 'subagent',
          targetable: item.origin !== 'subagent',
          updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
        };
        row.searchText = [row.sessionId, row.title ?? '', row.cwd ?? ''].join('\n').toLowerCase();
        return row;
      });
  }

  /** Resolve the working directory (and registered workspace) a new Session should use. */
  async #resolveSpawnWorkspace(input) {
    const registry = this.workspacesApi;
    const listed = typeof registry?.list === 'function' ? registry.list() ?? [] : [];
    const workspaces = listed.map((item) => ({
      id: String(item?.id ?? ''),
      path: String(item?.path ?? ''),
      title: item?.title === undefined ? undefined : String(item.title),
    }));
    if (typeof input.workspace === 'string' && input.workspace.trim() !== '') {
      const outcome = resolveWorkspaceQuery(workspaces, input.workspace);
      if (outcome.ok) return { id: outcome.workspace.id, cwd: outcome.workspace.path };
      // Fall back to an explicit directory path that is simply not registered yet.
      if (isAbsolutePath(input.workspace)) return { id: undefined, cwd: input.workspace.trim() };
      throw new Error(`${outcome.message}. Registered workspaces: ${formatWorkspaces(workspaces)}`);
    }
    const explicitCwd = typeof input.cwd === 'string' && input.cwd.trim() !== '' ? input.cwd.trim() : undefined;
    if (explicitCwd !== undefined) {
      const registered = workspaces.find((item) => sameWorkspace(item.path, explicitCwd));
      return registered === undefined ? { id: undefined, cwd: explicitCwd } : { id: registered.id, cwd: registered.path };
    }
    const callerCwd = input.sender?.cwd;
    if (typeof callerCwd !== 'string' || callerCwd === '') {
      throw new Error('session-bus: bus_spawn needs a workspace, a cwd, or a calling Session with a working directory');
    }
    const registered = workspaces.find((item) => sameWorkspace(item.path, callerCwd));
    return registered === undefined ? { id: undefined, cwd: callerCwd } : { id: registered.id, cwd: registered.path };
  }

  /** Append one audit record, never letting audit failure affect delivery. */
  async #audit(record) {
    if (!this.config.audit) return;
    const home = process.env.DSH_HOME;
    if (typeof home !== 'string' || home === '') return;
    const file = join(home, 'session-bus', 'audit.jsonl');
    this.auditQueue = this.auditQueue
      .then(async () => {
        await mkdir(join(home, 'session-bus'), { recursive: true });
        await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
      })
      .catch((error) => {
        if (typeof this.logger.warn === 'function') {
          this.logger.warn(`session-bus: audit record could not be written: ${String(error)}`);
        }
      });
    await this.auditQueue;
  }
}

/**
 * Build the session-bus core from plugin context.
 * @param {object} options - see {@link SessionBus}.
 * @returns {SessionBus} the core.
 */
export function createSessionBus(options) {
  return new SessionBus(options);
}

/** Reduce one Session event to a transcript entry, or `undefined` for other events. */
function toTranscriptEntry(event) {
  if (event === null || typeof event !== 'object') return undefined;
  if (event.type === 'user/message') {
    const text = textOf(event.data?.content);
    if (text === '') return undefined;
    return { role: 'user', time: event.time, text, viaBus: parseEnvelope(text) !== undefined };
  }
  if (event.type === 'assistant/message') {
    const text = textOf(event.data?.message?.content);
    if (text === '') return undefined;
    return { role: 'assistant', time: event.time, text, viaBus: false };
  }
  return undefined;
}

/** Join the text blocks of one content array. */
function textOf(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/** Number of user/assistant messages in an event window. */
function countMessages(events) {
  let count = 0;
  for (const event of events) if (event?.type === 'user/message' || event?.type === 'assistant/message') count += 1;
  return count;
}

/** Latest `session/title` in an event window. */
function titleOf(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') return event.data.title;
  }
  return undefined;
}

/** Whether a permission change actually happened. */
function permissionApplied(permission) {
  return typeof permission?.applied === 'string' && permission.applied !== '';
}

/** Name the effective preset of one Session, or `undefined` when it cannot be read. */
function safePresetName(presets, session) {
  try {
    const name = typeof presets?.current === 'function' ? presets.current(session) : undefined;
    return typeof name === 'string' && name !== '' ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Tell the receiving Session why it can suddenly do more.
 *
 * A permission change is visible in the Session's own log, and the model reading
 * that log should know the change came from the bus rather than from the user —
 * and that it is meant to be reverted when the delegated task is done.
 * @param {string} text - rendered envelope.
 * @param {string} preset - the preset that was applied.
 * @returns {string} the envelope plus one notice line.
 */
function injectPermissionNotice(text, preset) {
  const notice = `[session-bus] This Session was switched to the "${preset}" permission preset so the delegated message below can run here. Switch it back from the permission menu when the task is done.`;
  return `${text}\n${notice}\n`;
}

/**
 * Compose the delivery note, including what the permission step did.
 * @param {object} target - resolved target row.
 * @param {{applied?: string, current?: string, error?: string, skipped?: boolean}} permission - permission outcome.
 * @param {{sameWorkspace?: boolean, scopes?: string[], mode?: string}} [context] - delivery context.
 * @returns {string} one sentence per fact.
 */
function deliverNote(target, permission, context = {}) {
  const parts = [
    target.running === true
      ? 'The target Session is running a turn; the message is queued and will be handled when that turn ends.'
      : 'The target Session was idle or cold; it has been resumed and a new turn has been started with this message.',
  ];
  if (permissionApplied(permission)) {
    parts.push(`Permission raised to "${permission.applied}"${permission.current === undefined ? '' : ` (was "${permission.current}")`} so the target can run the task; it is restored when that turn ends.`);
  } else if (typeof permission?.error === 'string') {
    parts.push(`Permission could not be raised (${permission.error}); the target may be unable to run shell commands.`);
  } else if (permission?.skipped === true) {
    parts.push('Permission left untouched because this send asked for no elevation.');
  } else if (typeof permission?.current === 'string') {
    parts.push(`Target permission left at "${permission.current}".`);
  }
  if (context.mode === 'steer' && target.running === true) {
    parts.push('Steering a running turn interleaves with whatever it is doing right now — files it is editing included.');
  }
  if (context.sameWorkspace === true) {
    parts.push(
      context.scopes?.length > 0
        ? `The target shares your working directory; the write scope ${context.scopes.join(', ')} is in the message, keep your own writes out of it.`
        : 'The target shares your working directory and no write scope was given: say which paths are yours before either side edits.',
    );
  }
  return parts.join(' ');
}

/** Keep only usable, distinct write-scope entries. */
function normalizeScopes(scopes) {
  if (!Array.isArray(scopes)) return [];
  const seen = new Set();
  for (const scope of scopes) {
    if (typeof scope !== 'string') continue;
    const trimmed = scope.trim();
    if (trimmed === '') continue;
    seen.add(trimmed);
    if (seen.size >= 32) break;
  }
  return [...seen];
}

/** One-line candidate description for an error message. */
function formatCandidate(row) {
  const title = row.title === undefined || row.title === null ? '(untitled)' : row.title;
  return `${row.sessionId} "${title}"${row.cwd ? ` @ ${row.cwd}` : ''}`;
}

/** One-line workspace description for an error message. */
function formatWorkspaces(workspaces) {
  if (workspaces.length === 0) return '(none registered)';
  return workspaces.map((item) => `${item.title ?? '(untitled)'} @ ${item.path}`).join('; ');
}

/** Flatten one search-hit snippet into a single safe, bounded line. */
function cleanSnippet(text) {
  if (typeof text !== 'string') return undefined;
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat === '') return undefined;
  return flat.length > 240 ? `${flat.slice(0, 239)}…` : flat;
}

/** Split a question into lowercase search tokens, keeping CJK terms intact. */
function questionWords(question) {
  return question
    .toLowerCase()
    .split(/[\s,，。;；:：、!！?？()（）[\]【】"'“”‘’/\\|]+/)
    .filter((word) => word.length >= 2);
}

/** Rank one Session row by how much its metadata matches the question tokens. */
function metadataScore(row, words) {
  if (words.length === 0) return 0;
  const title = (row.title ?? '').toLowerCase();
  const cwd = (row.cwd ?? '').toLowerCase();
  const haystack = typeof row.searchText === 'string' ? row.searchText : `${title}\n${cwd}`;
  let score = 0;
  for (const word of words) {
    if (title.includes(word)) score += 3;
    else if (cwd.includes(word)) score += 2;
    else if (haystack.includes(word)) score += 1;
  }
  return score;
}

/** Clamp an optional integer option into `[min, max]`. */
function clampInteger(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

/** Whether a string is an absolute Windows or POSIX path. */
function isAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');
}

/** The Host's IANA time zone, when it can be determined safely. */
function safeTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * Build one identified, deeply frozen user-role message.
 *
 * This mirrors `createUserMessage()` from `@deepseek-ai/dsh-llm`: a fresh UUID
 * identity plus an immutable clone of `{role, content, source}`. A profile
 * plugin cannot import that package (it is not resolvable outside the DSH
 * installation), so the value shape is reproduced against the documented Agent
 * API (`Agent.followup()` / `Agent.steer()`).
 * @param {{text: string, source: object}} input - model-facing text and producer source.
 * @returns {object} immutable user message accepted by the Agent API.
 */
function createInboundMessage({ text, source }) {
  return deepFreeze(structuredClone({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  }));
}

/**
 * Freeze a JSON-shaped value and every object nested inside it, in place.
 * @template T
 * @param {T} value - value to freeze.
 * @returns {T} the same value.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}
