/**
 * Coordination state for the session bus: which Session plays which role in a
 * workspace, which work items are open, and which questions are waiting for a
 * human answer.
 *
 * The bus is a messaging layer; a workspace of cooperating Sessions needs three
 * more facts that messages alone do not carry:
 *
 * - **roles** — who is the one `main` Session a user talks to, and which `dev`
 *   Session owns which module. Without it every message has to name a raw
 *   sessionId, and a freshly spawned Session is indistinguishable from the one
 *   that coordinates the work.
 * - **tasks** — a small ledger of work items (`open` → `in_progress` →
 *   `blocked` → `ready` → `done`), so a hand-off can be claimed and reported
 *   instead of living only inside two private transcripts.
 * - **attention** — a question that needs a human decision, stored as one
 *   concrete question with bounded options. The main Session relays it; the dev
 *   Session does not have to stall behind a free-text transcript.
 *
 * Everything here is deliberately Host-free and synchronous: the bus core owns
 * persistence and delivery, this module owns the rules. Constructing one takes
 * a `reject(code, message, details)` function so refusals surface with the same
 * stable codes the rest of the bus uses.
 *
 * @module dsh-session-bus/coordination
 */

/** Roles a Session may register as. */
export const ROLE_VALUES = Object.freeze(['main', 'dev']);

/** Task lifecycle states. */
export const TASK_STATUS_VALUES = Object.freeze(['open', 'in_progress', 'blocked', 'ready', 'done', 'dropped']);

/** Attention lifecycle states. */
export const ATTENTION_STATUS_VALUES = Object.freeze(['open', 'answered', 'cancelled']);

/** Task states that no longer accept work. */
const CLOSED_TASK_STATUSES = new Set(['done', 'dropped']);

/** Upper bounds on remembered coordination state. */
const MAX_TASKS = 300;
const MAX_ATTENTIONS = 200;

/** Closed work is kept for a month, then pruned. */
const TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ATTENTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Longest accepted task title / attention question, in characters. */
const MAX_TITLE_CHARS = 200;
const MAX_CRITERIA_CHARS = 300;
const MAX_CRITERIA_ITEMS = 8;
const MAX_PREVIEW_CHARS = 240;
const MAX_QUESTION_CHARS = 500;
const MAX_ANSWER_CHARS = 2000;
const MAX_NOTE_CHARS = 2000;
const MAX_OPTIONS = 8;

/**
 * Normalize a path for comparison inside this module.
 *
 * `resolve.js` owns the same rule for the bus; coordination is unit-tested on
 * its own and must not import the Host-facing bus, so the small rule is local.
 * @param {string|undefined} path - path to normalize.
 * @returns {string} comparable key, or an empty string.
 */
function pathKey(path) {
  if (typeof path !== 'string') return '';
  const slashed = path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * Whether two paths name the same directory tree root.
 * @param {string|undefined} left - first path.
 * @param {string|undefined} right - second path.
 * @returns {boolean} true when both are non-empty and equal.
 */
export function samePath(left, right) {
  const a = pathKey(left);
  const b = pathKey(right);
  return a !== '' && a === b;
}

/** Trim one field to a bounded string, or `undefined` when empty. */
function text(value, limit) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

/** Coerce one timestamp to epoch milliseconds. */
function timeOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Roles: one `main` Session per workspace, plus any number of `dev` Sessions. */
export class RoleRegistry {
  /**
   * @param {object} options - construction options.
   * @param {() => number} [options.clock] - epoch-millisecond clock.
   * @param {(code: string, message: string, details?: object) => never} options.reject - refusal factory.
   */
  constructor({ clock, reject } = {}) {
    this.clock = clock ?? (() => Date.now());
    // eslint-disable-next-line no-unused-vars -- defaults keep the class usable in isolation.
    this.reject = reject ?? ((code, message, details) => {
      const error = new Error(`[${code}] ${message}`);
      error.code = code;
      error.details = details;
      throw error;
    });
    /** @type {Map<string, object>} sessionId -> role record. */
    this.roles = new Map();
  }

  /**
   * Register or update one Session's role.
   *
   * A workspace has at most one `main` Session: two coordinators would each
   * answer the user about the same work. Registering a second one is refused
   * unless the caller explicitly replaces the existing one with `force`.
   *
   * @param {object} input - registration.
   * @param {string} input.sessionId - Session being registered.
   * @param {'main'|'dev'} input.role - role to assign.
   * @param {string} [input.module] - module a `dev` Session owns (for example `Gys_Frontend`).
   * @param {string} [input.workspace] - workspace root this role belongs to.
   * @param {string} [input.cwd] - Session working directory.
   * @param {string} [input.title] - display title, when the caller knows one.
   * @param {boolean} [input.worker] - true for a temporary worker the bus spawned for one task.
   * @param {boolean} [input.force] - replace another `main` Session in that workspace.
   * @returns {object} the stored role record.
   */
  set(input) {
    const sessionId = text(input?.sessionId, 200);
    if (sessionId === undefined) this.reject('invalid_session', 'a role needs a Session id');
    const role = input?.role;
    if (!ROLE_VALUES.includes(role)) {
      this.reject('invalid_role', `unknown role "${String(role)}"; expected one of ${ROLE_VALUES.join(', ')}`, { role: String(role) });
    }
    const workspace = text(input.workspace, 1024);
    const cwd = text(input.cwd, 1024);
    const module = role === 'dev' ? text(input.module, 120) : undefined;
    if (role === 'main') {
      const current = this.main({ workspace, cwd });
      if (current !== undefined && current.sessionId !== sessionId && input.force !== true) {
        this.reject(
          'main_exists',
          `workspace "${workspace ?? cwd ?? '(unknown)'}" already has main Session "${current.sessionId}"; a workspace must not have two main Sessions — pass force: true to replace it deliberately`,
          { sessionId: current.sessionId },
        );
      }
      if (current !== undefined && current.sessionId !== sessionId) this.roles.delete(current.sessionId);
    }
    const at = this.clock();
    const existing = this.roles.get(sessionId);
    const record = {
      sessionId,
      role,
      ...module === undefined ? {} : { module },
      ...workspace === undefined ? {} : { workspace },
      ...cwd === undefined ? {} : { cwd },
      ...text(input.title, 120) === undefined ? {} : { title: text(input.title, 120) },
      ...input?.worker === true ? { worker: true } : {},
      registeredAt: existing?.registeredAt ?? at,
      updatedAt: at,
    };
    this.roles.set(sessionId, record);
    return { ...record };
  }

  /**
   * Read one Session's role record.
   * @param {string} sessionId - Session to look up.
   * @returns {object|undefined} the record, when registered.
   */
  get(sessionId) {
    const record = this.roles.get(String(sessionId ?? ''));
    return record === undefined ? undefined : { ...record };
  }

  /**
   * Read the `main` Session of a workspace.
   * @param {object} [options] - filter.
   * @param {string} [options.workspace] - workspace root to match.
   * @param {string} [options.cwd] - Session directory to match instead.
   * @returns {object|undefined} the matching record.
   */
  main(options = {}) {
    const candidates = this.#mains().filter((record) => {
      if (options.workspace !== undefined || options.cwd !== undefined) {
        const wanted = options.workspace ?? options.cwd;
        if (!samePath(record.workspace, wanted) && !samePath(record.cwd, wanted)) return false;
      }
      return true;
    });
    return candidates[0];
  }

  /**
   * Every `main` Session, optionally narrowed to a workspace.
   * @param {object} [options] - filter.
   * @returns {object[]} matching records, oldest registration first.
   */
  mains(options = {}) {
    return this.#mains().filter((record) => {
      if (options.workspace === undefined && options.cwd === undefined) return true;
      const wanted = options.workspace ?? options.cwd;
      return samePath(record.workspace, wanted) || samePath(record.cwd, wanted);
    });
  }

  /** @returns {object[]} all `main` records ordered by registration. */
  #mains() {
    return [...this.roles.values()]
      .filter((record) => record.role === 'main')
      .sort((left, right) => left.registeredAt - right.registeredAt || left.sessionId.localeCompare(right.sessionId))
      .map((record) => ({ ...record }));
  }

  /**
   * List registered roles, newest update first within each role.
   * @param {object} [options] - filter.
   * @param {'main'|'dev'} [options.role] - keep one role.
   * @param {string} [options.workspace] - keep one workspace tree.
   * @param {string} [options.module] - keep one module.
   * @returns {object[]} matching records.
   */
  list(options = {}) {
    const rows = [...this.roles.values()].filter((record) => {
      if (options.role !== undefined && record.role !== options.role) return false;
      if (options.module !== undefined && record.module !== options.module) return false;
      if (options.workspace !== undefined) {
        return samePath(record.workspace, options.workspace) || samePath(record.cwd, options.workspace);
      }
      return true;
    });
    return rows
      .sort((left, right) => {
        if (left.role !== right.role) return left.role === 'main' ? -1 : 1;
        return right.updatedAt - left.updatedAt;
      })
      .map((record) => ({ ...record }));
  }

  /**
   * Forget one Session's role (for example when its work is handed back).
   * @param {string} sessionId - Session to remove.
   * @returns {boolean} whether a record was removed.
   */
  remove(sessionId) {
    return this.roles.delete(String(sessionId ?? ''));
  }

  /** @returns {object} JSON-safe snapshot. */
  toJSON() {
    return { roles: [...this.roles.values()].map((record) => ({ ...record })) };
  }

  /**
   * Restore a snapshot produced by {@link toJSON}.
   * @param {object} [data] - persisted state.
   * @returns {void}
   */
  restore(data) {
    const records = Array.isArray(data?.roles) ? data.roles : [];
    for (const record of records) {
      if (record === null || typeof record !== 'object') continue;
      if (typeof record.sessionId !== 'string' || !ROLE_VALUES.includes(record.role)) continue;
      this.roles.set(record.sessionId, {
        sessionId: record.sessionId,
        role: record.role,
        ...typeof record.module === 'string' ? { module: record.module } : {},
        ...typeof record.workspace === 'string' ? { workspace: record.workspace } : {},
        ...typeof record.cwd === 'string' ? { cwd: record.cwd } : {},
        ...typeof record.title === 'string' ? { title: record.title } : {},
        ...record.worker === true ? { worker: true } : {},
        registeredAt: timeOf(record.registeredAt) || this.clock(),
        updatedAt: timeOf(record.updatedAt) || this.clock(),
      });
    }
  }
}

/** A small work-item ledger shared by every Session of a workspace. */
export class TaskLedger {
  /**
   * @param {object} options - construction options.
   * @param {() => number} [options.clock] - epoch-millisecond clock.
   * @param {() => string} [options.idFactory] - task id factory (12 hex-ish chars).
   * @param {(code: string, message: string, details?: object) => never} [options.reject] - refusal factory.
   */
  constructor({ clock, idFactory, reject } = {}) {
    this.clock = clock ?? (() => Date.now());
    this.idFactory = idFactory ?? (() => Math.random().toString(16).slice(2, 14).padEnd(12, '0'));
    this.reject = reject ?? ((code, message, details) => {
      const error = new Error(`[${code}] ${message}`);
      error.code = code;
      error.details = details;
      throw error;
    });
    /** @type {Map<string, object>} */
    this.tasks = new Map();
  }

  /**
   * Open a task.
   *
   * A task is deliberately small: what should be done, which module owns it,
   * where it is worked, and who opened it. Acceptance criteria belong in the
   * title/notes; the main Session routes, the dev Session owns the details.
   *
   * @param {object} input - creation input.
   * @param {string} input.title - what should be done.
   * @param {string} [input.module] - module the task belongs to.
   * @param {string} [input.assignee] - Session expected to do it, when known.
   * @param {string} [input.cwd] - working directory when the work is done.
   * @param {string} [input.workspace] - workspace root.
   * @param {string|string[]} [input.acceptance] - how the result is judged done.
   * @param {string|string[]} [input.constraints] - red lines the worker must keep.
   * @param {string} [input.sessionId] - Session that owns the requirement.
   * @param {string} input.createdBy - Session opening the task (its owner).
   * @param {string} [input.note] - first note.
   * @returns {object} the stored task.
   */
  create(input) {
    const title = text(input?.title, MAX_TITLE_CHARS);
    if (title === undefined) this.reject('invalid_title', 'a task needs a non-empty title');
    const createdBy = text(input.createdBy, 200);
    if (createdBy === undefined) this.reject('no_sender', 'a task needs the Session that opened it');
    const at = this.clock();
    const task = {
      taskId: `t-${this.idFactory()}`,
      title,
      module: text(input.module, 120),
      status: 'open',
      owner: createdBy,
      assignee: text(input.assignee, 200),
      sessionId: text(input.sessionId, 200),
      cwd: text(input.cwd, 1024),
      workspace: text(input.workspace, 1024),
      acceptance: this.#criteria(input.acceptance),
      constraints: this.#criteria(input.constraints),
      threadIds: [],
      notes: [],
      evidence: [],
      attentionIds: [],
      createdAt: at,
      updatedAt: at,
    };
    if (text(input.note, MAX_NOTE_CHARS) !== undefined) {
      task.notes.push({ at, by: createdBy, text: text(input.note, MAX_NOTE_CHARS) });
    }
    // Drop the obsolete keys without leaving `undefined` values in JSON.
    for (const key of ['module', 'assignee', 'sessionId', 'cwd', 'workspace']) if (task[key] === undefined) delete task[key];
    this.tasks.set(task.taskId, task);
    this.#prune();
    return this.#view(task);
  }

  /**
   * Read one task.
   * @param {string} taskId - task id.
   * @returns {object} task view.
   */
  get(taskId) {
    const task = this.tasks.get(String(taskId ?? ''));
    if (task === undefined) this.reject('task_not_found', `no task "${String(taskId ?? '')}" exists`, { taskId: String(taskId ?? '') });
    return this.#view(task);
  }

  /**
   * Claim a task for a Session: it becomes `in_progress` and gains an assignee.
   * @param {object} input - claim input.
   * @param {string} input.taskId - task to claim.
   * @param {string} input.by - claiming Session.
   * @param {string} [input.note] - optional note.
   * @returns {object} the updated task view.
   */
  claim(input) {
    const task = this.#require(input?.taskId);
    const by = text(input.by, 200);
    if (by === undefined) this.reject('no_sender', 'claiming a task needs the claiming Session');
    if (CLOSED_TASK_STATUSES.has(task.status)) this.reject('task_closed', `task ${task.taskId} is already ${task.status}`, { taskId: task.taskId });
    if (typeof task.assignee === 'string' && task.assignee !== by) {
      this.reject('task_owned', `task ${task.taskId} is assigned to "${task.assignee}"`, { taskId: task.taskId, assignee: task.assignee });
    }
    task.assignee = by;
    task.status = 'in_progress';
    this.#note(task, by, input.note);
    return this.#view(task);
  }

  /**
   * Update one task's status and/or add a note or evidence.
   *
   * `ready` requires evidence: "the PR exists" is not the same thing as "the
   * work is finished and checked", so the ledger refuses a ready report that
   * carries no proof of work.
   *
   * @param {object} input - update input.
   * @param {string} input.taskId - task to update.
   * @param {string} input.by - updating Session.
   * @param {string} [input.status] - next status.
   * @param {string} [input.note] - note to append.
   * @param {string|string[]} [input.evidence] - proof of work (command output, commit, URL).
   * @param {string|string[]} [input.acceptance] - replace the acceptance criteria.
   * @param {string|string[]} [input.constraints] - replace the red lines.
   * @returns {object} the updated task view.
   */
  update(input) {
    const task = this.#require(input?.taskId);
    const by = text(input.by, 200);
    if (by === undefined) this.reject('no_sender', 'updating a task needs the updating Session');
    const allowed = task.assignee === by || task.owner === by;
    if (!allowed) {
      this.reject('task_owned', `task ${task.taskId} belongs to "${task.assignee ?? task.owner}"; only the owner or assignee updates it`, {
        taskId: task.taskId,
      });
    }
    if (CLOSED_TASK_STATUSES.has(task.status)) {
      this.reject('task_closed', `task ${task.taskId} is already ${task.status}; open a new task instead of editing closed work`, {
        taskId: task.taskId,
      });
    }
    let changed = false;
    if (input.status !== undefined) {
      if (!TASK_STATUS_VALUES.includes(input.status)) {
        this.reject('invalid_status', `unknown task status "${String(input.status)}"; expected one of ${TASK_STATUS_VALUES.join(', ')}`, {
          status: String(input.status),
        });
      }
      if (input.status === 'ready') {
        const evidence = this.#evidence(input.evidence);
        if (evidence.length === 0 && task.evidence.length === 0) {
          this.reject('evidence_required', 'a task can only be reported ready with evidence (command result, commit, URL); describe what was checked', {
            taskId: task.taskId,
          });
        }
        task.evidence.push(...evidence);
      }
      task.status = input.status;
      if (input.status === 'done' || input.status === 'dropped') task.closedAt = this.clock();
      changed = true;
    }
    if (input.evidence !== undefined && input.status !== 'ready') {
      const evidence = this.#evidence(input.evidence);
      if (evidence.length > 0) {
        task.evidence.push(...evidence);
        changed = true;
      }
    }
    if (input.acceptance !== undefined) {
      task.acceptance = this.#criteria(input.acceptance);
      changed = true;
    }
    if (input.constraints !== undefined) {
      task.constraints = this.#criteria(input.constraints);
      changed = true;
    }
    changed = this.#note(task, by, input.note) || changed;
    if (!changed) this.reject('empty_update', 'an update needs a status, a note, or evidence');
    return this.#view(task);
  }

  /**
   * Bind a task to the requirement Session and/or the bus thread that carries it.
   *
   * This is what makes "one requirement, one Session, one conversation" real: a
   * spawned requirement Session is bound once, and every later message inherits
   * the task from the thread instead of restating it.
   *
   * @param {object} input - binding input.
   * @param {string} input.taskId - task to bind.
   * @param {string} [input.sessionId] - Session that owns the requirement.
   * @param {string} [input.assignee] - Session expected to do the work.
   * @param {string} [input.module] - module, filled in only when not set.
   * @param {string} [input.cwd] - working directory, filled in only when not set.
   * @param {string} [input.workspace] - workspace root, filled in only when not set.
   * @param {string} [input.threadId] - thread that carries this task.
   * @returns {object} the updated task view.
   */
  bind(input) {
    const task = this.#require(input?.taskId);
    let changed = false;
    const sessionId = text(input.sessionId, 200);
    if (sessionId !== undefined && task.sessionId !== sessionId) {
      task.sessionId = sessionId;
      changed = true;
    }
    const assignee = text(input.assignee, 200);
    if (assignee !== undefined && task.assignee !== assignee) {
      task.assignee = assignee;
      changed = true;
    }
    if (task.sessionId !== undefined && task.assignee === undefined) {
      task.assignee = task.sessionId;
      changed = true;
    }
    for (const key of ['module', 'cwd', 'workspace']) {
      const value = text(input[key], key === 'module' ? 120 : 1024);
      if (value !== undefined && task[key] === undefined) {
        task[key] = value;
        changed = true;
      }
    }
    const threadId = text(input.threadId, 120);
    if (threadId !== undefined && !task.threadIds.includes(threadId)) {
      task.threadIds.push(threadId);
      changed = true;
    }
    if (changed) task.updatedAt = this.clock();
    return this.#view(task);
  }

  /**
   * Remember the newest bus message that belongs to a task.
   *
   * The task card and `bus_task list` answer "what is happening on this
   * requirement" without opening any transcript, so the last touch is stored
   * instead of recomputed from the audit log.
   * @param {object} input - touch input.
   * @param {string} input.taskId - task the message belongs to.
   * @param {string} [input.from] - Session that sent the message.
   * @param {string} [input.kind] - message kind.
   * @param {string} [input.messageId] - bus message id.
   * @param {string} [input.threadId] - thread the message travelled on.
   * @param {string} [input.preview] - one-line preview of the message.
   * @returns {object|undefined} the updated task view, when the task exists.
   */
  touch(input) {
    const task = this.tasks.get(String(input?.taskId ?? ''));
    if (task === undefined) return undefined;
    const at = this.clock();
    const preview = text(input.preview, MAX_PREVIEW_CHARS);
    task.last = {
      at,
      ...text(input.from, 200) === undefined ? {} : { from: text(input.from, 200) },
      ...text(input.kind, 40) === undefined ? {} : { kind: text(input.kind, 40) },
      ...text(input.messageId, 120) === undefined ? {} : { messageId: text(input.messageId, 120) },
      ...text(input.threadId, 120) === undefined ? {} : { threadId: text(input.threadId, 120) },
      ...preview === undefined ? {} : { preview },
    };
    task.updatedAt = at;
    return this.#view(task);
  }

  /**
   * List tasks, newest activity first.
   * @param {object} [options] - filter.
   * @param {string} [options.status] - one status, or `all`/`open`/`closed`.
   * @param {string} [options.module] - module filter.
   * @param {string} [options.assignee] - assignee filter.
   * @param {string} [options.mine] - Session whose tasks to keep (owner or assignee).
   * @param {string} [options.workspace] - workspace filter.
   * @param {number} [options.limit] - maximum rows (default 30).
   * @returns {{total: number, tasks: object[]}} matching tasks.
   */
  list(options = {}) {
    const limit = Math.min(Math.max(Number.isInteger(options.limit) ? options.limit : 30, 1), 100);
    const wanted = typeof options.status === 'string' ? options.status.trim() : '';
    const rows = [...this.tasks.values()].filter((task) => {
      if (wanted !== '' && wanted !== 'all') {
        if (wanted === 'closed') {
          if (!CLOSED_TASK_STATUSES.has(task.status)) return false;
        } else if (wanted === 'active') {
          if (CLOSED_TASK_STATUSES.has(task.status)) return false;
        } else if (task.status !== wanted) {
          return false;
        }
      }
      if (options.module !== undefined && task.module !== options.module) return false;
      if (options.assignee !== undefined && task.assignee !== options.assignee) return false;
      if (options.workspace !== undefined && !samePath(task.workspace, options.workspace)) return false;
      if (typeof options.mine === 'string' && task.owner !== options.mine && task.assignee !== options.mine) return false;
      return true;
    });
    rows.sort((left, right) => right.updatedAt - left.updatedAt);
    return { total: rows.length, tasks: rows.slice(0, limit).map((task) => this.#view(task)) };
  }

  /**
   * Move a task to `blocked` because a question is waiting for a human.
   * @param {string} taskId - task to block.
   * @param {string} attentionId - attention that blocks it.
   * @returns {object} the updated task view.
   */
  block(taskId, attentionId) {
    const task = this.#require(taskId);
    if (!CLOSED_TASK_STATUSES.has(task.status)) task.status = 'blocked';
    if (!task.attentionIds.includes(attentionId)) task.attentionIds.push(attentionId);
    task.updatedAt = this.clock();
    return this.#view(task);
  }

  /**
   * Release a task from `blocked` once its attention is settled.
   * @param {string} taskId - task to resume.
   * @returns {object|undefined} the updated task view, when the task exists.
   */
  resume(taskId) {
    const task = this.tasks.get(String(taskId ?? ''));
    if (task === undefined) return undefined;
    if (task.status === 'blocked') task.status = 'in_progress';
    task.updatedAt = this.clock();
    return this.#view(task);
  }

  /**
   * Forget one settled question and release the task when it was the last one.
   * @param {string} taskId - task that was blocked.
   * @param {string} attentionId - question that is answered or cancelled.
   * @returns {object|undefined} the updated task view, when the task exists.
   */
  settle(taskId, attentionId) {
    const task = this.tasks.get(String(taskId ?? ''));
    if (task === undefined) return undefined;
    task.attentionIds = task.attentionIds.filter((id) => id !== attentionId);
    if (task.status === 'blocked' && task.attentionIds.length === 0) task.status = 'in_progress';
    task.updatedAt = this.clock();
    return this.#view(task);
  }

  /** @returns {object} JSON-safe snapshot. */
  toJSON() {
    return { tasks: [...this.tasks.values()].map((task) => ({ ...task })) };
  }

  /**
   * Restore a snapshot produced by {@link toJSON}.
   * @param {object} [data] - persisted state.
   * @returns {void}
   */
  restore(data) {
    this.tasks.clear();
    const rows = Array.isArray(data?.tasks) ? data.tasks : [];
    for (const record of rows) {
      if (record === null || typeof record !== 'object') continue;
      if (typeof record.taskId !== 'string' || typeof record.title !== 'string') continue;
      if (!TASK_STATUS_VALUES.includes(record.status)) continue;
      this.tasks.set(record.taskId, {
        taskId: record.taskId,
        title: record.title,
        ...typeof record.module === 'string' ? { module: record.module } : {},
        status: record.status,
        owner: typeof record.owner === 'string' ? record.owner : 'unknown',
        ...typeof record.assignee === 'string' ? { assignee: record.assignee } : {},
        ...typeof record.cwd === 'string' ? { cwd: record.cwd } : {},
        ...typeof record.workspace === 'string' ? { workspace: record.workspace } : {},
        ...typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {},
        acceptance: Array.isArray(record.acceptance) ? record.acceptance.filter((entry) => typeof entry === 'string') : [],
        constraints: Array.isArray(record.constraints) ? record.constraints.filter((entry) => typeof entry === 'string') : [],
        threadIds: Array.isArray(record.threadIds) ? record.threadIds.filter((id) => typeof id === 'string') : [],
        ...record.last === null || typeof record.last !== 'object' ? {} : {
          last: {
            at: timeOf(record.last.at),
            ...typeof record.last.from === 'string' ? { from: record.last.from } : {},
            ...typeof record.last.kind === 'string' ? { kind: record.last.kind } : {},
            ...typeof record.last.messageId === 'string' ? { messageId: record.last.messageId } : {},
            ...typeof record.last.threadId === 'string' ? { threadId: record.last.threadId } : {},
            ...typeof record.last.preview === 'string' ? { preview: record.last.preview } : {},
          },
        },
        notes: Array.isArray(record.notes) ? record.notes.filter((note) => note !== null && typeof note === 'object') : [],
        evidence: Array.isArray(record.evidence) ? record.evidence.filter((entry) => typeof entry === 'string') : [],
        attentionIds: Array.isArray(record.attentionIds) ? record.attentionIds.filter((id) => typeof id === 'string') : [],
        createdAt: timeOf(record.createdAt),
        updatedAt: timeOf(record.updatedAt),
        ...timeOf(record.closedAt) === 0 ? {} : { closedAt: timeOf(record.closedAt) },
      });
    }
  }

  /** Resolve one task or refuse. */
  #require(taskId) {
    const task = this.tasks.get(String(taskId ?? ''));
    if (task === undefined) this.reject('task_not_found', `no task "${String(taskId ?? '')}" exists`, { taskId: String(taskId ?? '') });
    return task;
  }

  /** Append one note, returning whether the input had one. */
  #note(task, by, note) {
    const trimmed = text(note, MAX_NOTE_CHARS);
    if (trimmed === undefined) return false;
    task.notes.push({ at: this.clock(), by, text: trimmed });
    task.updatedAt = this.clock();
    return true;
  }

  /** Normalize one evidence input into a bounded list of strings. */
  #evidence(value) {
    const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
    const out = [];
    for (const entry of list) {
      const trimmed = text(entry, 1000);
      if (trimmed !== undefined) out.push(trimmed);
    }
    return out;
  }

  /** Normalize acceptance criteria or constraints into a bounded string list. */
  #criteria(value) {
    const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
    const out = [];
    for (const entry of list) {
      const trimmed = text(entry, MAX_CRITERIA_CHARS);
      if (trimmed !== undefined) out.push(trimmed);
      if (out.length >= MAX_CRITERIA_ITEMS) break;
    }
    return out;
  }

  /** Public shape of one task. */
  #view(task) {
    return {
      taskId: task.taskId,
      title: task.title,
      ...task.module === undefined ? {} : { module: task.module },
      status: task.status,
      owner: task.owner,
      ...task.assignee === undefined ? {} : { assignee: task.assignee },
      ...task.cwd === undefined ? {} : { cwd: task.cwd },
      ...task.workspace === undefined ? {} : { workspace: task.workspace },
      ...task.sessionId === undefined ? {} : { sessionId: task.sessionId },
      acceptance: [...(task.acceptance ?? [])],
      constraints: [...(task.constraints ?? [])],
      threadIds: [...(task.threadIds ?? [])],
      ...task.last === undefined ? {} : { last: { ...task.last, at: new Date(task.last.at).toISOString() } },
      notes: task.notes.map((note) => ({ ...note })),
      evidence: [...task.evidence],
      attentionIds: [...task.attentionIds],
      openAttentions: task.attentionIds.filter((id) => id.startsWith('a-')).length,
      createdAt: new Date(task.createdAt).toISOString(),
      updatedAt: new Date(task.updatedAt).toISOString(),
      ...task.closedAt === undefined ? {} : { closedAt: new Date(task.closedAt).toISOString() },
    };
  }

  /** Drop old closed tasks and cap the ledger. */
  #prune() {
    const now = this.clock();
    for (const [taskId, task] of this.tasks) {
      if (CLOSED_TASK_STATUSES.has(task.status) && timeOf(task.closedAt) !== 0 && now - task.closedAt > TASK_RETENTION_MS) {
        this.tasks.delete(taskId);
      }
    }
    if (this.tasks.size <= MAX_TASKS) return;
    const closed = [...this.tasks.values()]
      .filter((task) => CLOSED_TASK_STATUSES.has(task.status))
      .sort((left, right) => timeOf(left.closedAt) - timeOf(right.closedAt));
    for (const task of closed) {
      if (this.tasks.size <= MAX_TASKS) break;
      this.tasks.delete(task.taskId);
    }
  }
}

/** Questions that need a human decision, tied to one task. */
export class AttentionLedger {
  /**
   * @param {object} options - construction options.
   * @param {() => number} [options.clock] - epoch-millisecond clock.
   * @param {() => string} [options.idFactory] - attention id factory.
   * @param {(code: string, message: string, details?: object) => never} [options.reject] - refusal factory.
   * @param {TaskLedger} options.tasks - ledger the attention blocks and resumes.
   */
  constructor({ clock, idFactory, reject, tasks } = {}) {
    this.clock = clock ?? (() => Date.now());
    this.idFactory = idFactory ?? (() => Math.random().toString(16).slice(2, 14).padEnd(12, '0'));
    this.reject = reject ?? ((code, message, details) => {
      const error = new Error(`[${code}] ${message}`);
      error.code = code;
      error.details = details;
      throw error;
    });
    this.tasks = tasks;
    /** @type {Map<string, object>} */
    this.attentions = new Map();
  }

  /**
   * Ask one concrete question about a task.
   *
   * Exactly one question: a list of concerns in one message is what makes an
   * agent wait without a decision. Bounded options and a recommendation let the
   * human answer by picking, and let the main Session relay without rewriting.
   *
   * @param {object} input - question input.
   * @param {string} input.taskId - task this question blocks.
   * @param {string} input.question - what must be decided.
   * @param {string[]} [input.options] - bounded choices.
   * @param {string} [input.recommendation] - suggested answer.
   * @param {string} input.askedBy - asking Session.
   * @returns {object} the stored attention.
   */
  create(input) {
    const question = text(input?.question, MAX_QUESTION_CHARS);
    if (question === undefined) this.reject('invalid_question', 'an attention needs a non-empty question');
    const askedBy = text(input.askedBy, 200);
    if (askedBy === undefined) this.reject('no_sender', 'an attention needs the Session that asks it');
    const taskId = text(input.taskId, 200);
    if (taskId === undefined) this.reject('invalid_task', 'an attention must name the task it blocks');
    // Requiring the task to exist keeps questions anchored to work that is
    // actually in the ledger instead of floating in the transcript.
    if (this.tasks !== undefined) this.tasks.get(taskId);
    const options = [];
    if (Array.isArray(input.options)) {
      for (const entry of input.options.slice(0, MAX_OPTIONS)) {
        const option = text(entry, MAX_TITLE_CHARS);
        if (option !== undefined && !options.includes(option)) options.push(option);
      }
    }
    const at = this.clock();
    const attention = {
      attentionId: `a-${this.idFactory()}`,
      taskId,
      question,
      ...options.length === 0 ? {} : { options },
      recommendation: text(input.recommendation, MAX_TITLE_CHARS),
      status: 'open',
      askedBy,
      createdAt: at,
      updatedAt: at,
    };
    for (const key of ['options', 'recommendation']) if (attention[key] === undefined) delete attention[key];
    this.attentions.set(attention.attentionId, attention);
    if (this.tasks !== undefined) this.tasks.block(taskId, attention.attentionId);
    this.#prune();
    return this.#view(attention);
  }

  /**
   * Answer one open question and release the task it blocks.
   * @param {object} input - answer input.
   * @param {string} input.attentionId - attention being answered.
   * @param {string} input.answer - the decision.
   * @param {string} input.answeredBy - Session recording the answer.
   * @returns {object} the updated attention.
   */
  answer(input) {
    const attention = this.#open(input?.attentionId);
    const answer = text(input.answer, MAX_ANSWER_CHARS);
    if (answer === undefined) this.reject('invalid_answer', 'an answer must contain non-whitespace text');
    const answeredBy = text(input.answeredBy, 200);
    if (answeredBy === undefined) this.reject('no_sender', 'an answer needs the Session that records it');
    attention.status = 'answered';
    attention.answer = answer;
    attention.answeredBy = answeredBy;
    attention.answeredAt = this.clock();
    attention.updatedAt = attention.answeredAt;
    if (this.tasks !== undefined) {
      if (typeof this.tasks.settle === 'function') this.tasks.settle(attention.taskId, attention.attentionId);
      else this.tasks.resume(attention.taskId);
    }
    return this.#view(attention);
  }

  /**
   * Cancel one open question without an answer.
   * @param {object} input - cancel input.
   * @param {string} input.attentionId - attention to cancel.
   * @param {string} [input.reason] - why it is no longer needed.
   * @param {string} input.by - Session cancelling it.
   * @returns {object} the updated attention.
   */
  cancel(input) {
    const attention = this.#open(input?.attentionId);
    attention.status = 'cancelled';
    attention.cancelledBy = text(input.by, 200);
    attention.cancelledAt = this.clock();
    attention.updatedAt = attention.cancelledAt;
    const reason = text(input.reason, MAX_ANSWER_CHARS);
    if (reason !== undefined) attention.reason = reason;
    if (this.tasks !== undefined) {
      if (typeof this.tasks.settle === 'function') this.tasks.settle(attention.taskId, attention.attentionId);
      else this.tasks.resume(attention.taskId);
    }
    return this.#view(attention);
  }

  /**
   * List attentions, newest first.
   * @param {object} [options] - filter.
   * @param {string} [options.status] - `open` (default), `answered`, `cancelled`, or `all`.
   * @param {string} [options.taskId] - keep one task's questions.
   * @param {number} [options.limit] - maximum rows (default 30).
   * @returns {{total: number, attentions: object[]}} matching attentions.
   */
  list(options = {}) {
    const limit = Math.min(Math.max(Number.isInteger(options.limit) ? options.limit : 30, 1), 100);
    const wanted = typeof options.status === 'string' && options.status.trim() !== '' ? options.status.trim() : 'open';
    const rows = [...this.attentions.values()].filter((attention) => {
      if (wanted !== 'all' && attention.status !== wanted) return false;
      if (options.taskId !== undefined && attention.taskId !== options.taskId) return false;
      return true;
    });
    rows.sort((left, right) => right.updatedAt - left.updatedAt);
    return { total: rows.length, attentions: rows.slice(0, limit).map((attention) => this.#view(attention)) };
  }

  /** @returns {object} JSON-safe snapshot. */
  toJSON() {
    return { attentions: [...this.attentions.values()].map((attention) => ({ ...attention })) };
  }

  /**
   * Restore a snapshot produced by {@link toJSON}.
   * @param {object} [data] - persisted state.
   * @returns {void}
   */
  restore(data) {
    this.attentions.clear();
    const rows = Array.isArray(data?.attentions) ? data.attentions : [];
    for (const record of rows) {
      if (record === null || typeof record !== 'object') continue;
      if (typeof record.attentionId !== 'string' || typeof record.question !== 'string') continue;
      if (!ATTENTION_STATUS_VALUES.includes(record.status)) continue;
      this.attentions.set(record.attentionId, {
        attentionId: record.attentionId,
        taskId: typeof record.taskId === 'string' ? record.taskId : '',
        question: record.question,
        ...Array.isArray(record.options) ? { options: record.options.filter((entry) => typeof entry === 'string') } : {},
        ...typeof record.recommendation === 'string' ? { recommendation: record.recommendation } : {},
        status: record.status,
        askedBy: typeof record.askedBy === 'string' ? record.askedBy : 'unknown',
        ...typeof record.answer === 'string' ? { answer: record.answer } : {},
        ...typeof record.answeredBy === 'string' ? { answeredBy: record.answeredBy } : {},
        ...typeof record.reason === 'string' ? { reason: record.reason } : {},
        createdAt: timeOf(record.createdAt),
        updatedAt: timeOf(record.updatedAt),
      });
    }
  }

  /** Resolve one open attention or refuse. */
  #open(attentionId) {
    const attention = this.attentions.get(String(attentionId ?? ''));
    if (attention === undefined) {
      this.reject('attention_not_found', `no attention "${String(attentionId ?? '')}" exists`, { attentionId: String(attentionId ?? '') });
    }
    if (attention.status !== 'open') {
      this.reject('attention_closed', `attention ${attention.attentionId} is already ${attention.status}`, {
        attentionId: attention.attentionId,
        status: attention.status,
      });
    }
    return attention;
  }

  /** Public shape of one attention. */
  #view(attention) {
    return {
      attentionId: attention.attentionId,
      taskId: attention.taskId,
      question: attention.question,
      ...attention.options === undefined ? {} : { options: [...attention.options] },
      ...attention.recommendation === undefined ? {} : { recommendation: attention.recommendation },
      status: attention.status,
      askedBy: attention.askedBy,
      ...attention.answer === undefined ? {} : { answer: attention.answer },
      ...attention.answeredBy === undefined ? {} : { answeredBy: attention.answeredBy },
      ...attention.reason === undefined ? {} : { reason: attention.reason },
      createdAt: new Date(attention.createdAt).toISOString(),
      updatedAt: new Date(attention.updatedAt).toISOString(),
    };
  }

  /** Drop old settled attentions and cap the ledger. */
  #prune() {
    const now = this.clock();
    for (const [attentionId, attention] of this.attentions) {
      if (attention.status !== 'open' && now - attention.updatedAt > ATTENTION_RETENTION_MS) {
        this.attentions.delete(attentionId);
      }
    }
    if (this.attentions.size <= MAX_ATTENTIONS) return;
    const settled = [...this.attentions.values()]
      .filter((attention) => attention.status !== 'open')
      .sort((left, right) => left.updatedAt - right.updatedAt);
    for (const attention of settled) {
      if (this.attentions.size <= MAX_ATTENTIONS) break;
      this.attentions.delete(attention.attentionId);
    }
  }
}
