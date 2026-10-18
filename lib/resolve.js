/**
 * Pure target resolution for the session bus.
 *
 * A model names a target Session with whatever it can see: a full id, an id
 * prefix, a title, a working directory, or the `self` alias. Resolution is
 * strictly ordered and never guesses: the first rung that produces matches
 * decides, and more than one match on that rung is reported as ambiguous
 * instead of picking one.
 *
 * @module dsh-session-bus/resolve
 */

/** Aliases that mean "the Session calling this tool". */
const SELF_ALIASES = new Set(['self', 'this', 'me', '自己', '本会话', '当前会话']);

/** Minimum id prefix length accepted before falling back to fuzzy matching. */
const MIN_ID_PREFIX = 6;

/**
 * Normalize a path or name for case-insensitive comparison.
 * @param {string} value - raw value.
 * @returns {string} lowercased value with uniform separators.
 */
export function normalizeForCompare(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Resolve one user-supplied target reference against the visible Session rows.
 * @param {Array<object>} rows - normalized Session rows (see `SessionBus#list`).
 * @param {string} query - the requested target: id, id prefix, title, cwd, or alias.
 * @param {object} [options] - resolution options.
 * @param {string} [options.selfId] - the calling Session id, used by the `self` alias.
 * @param {boolean} [options.allowSelf] - whether the caller itself is a legal target.
 * @returns {{ok: true, row: object, how: string} | {ok: false, reason: string, message: string, candidates: Array<object>}}
 */
export function resolveSessionQuery(rows, query, options = {}) {
  const raw = typeof query === 'string' ? query.trim() : '';
  if (raw === '') {
    return failure('empty', 'the target Session reference must not be empty', []);
  }
  const targetable = rows.filter((row) => row.targetable !== false);
  const needle = normalizeForCompare(raw);

  if (SELF_ALIASES.has(needle)) {
    const row = rows.find((candidate) => candidate.sessionId === options.selfId);
    if (row === undefined) {
      return failure('self-unknown', 'the calling Session could not be identified', []);
    }
    if (options.allowSelf === false) {
      return failure('self-refused', 'sending to your own Session is disabled in this deployment', [row]);
    }
    return { ok: true, row, how: 'alias:self' };
  }

  // A subagent Session cannot be pushed into; name that explicitly instead of
  // returning a puzzling "not found" for an id the model just saw.
  const excluded = rows.filter((row) => row.targetable === false);
  const excludedExact = excluded.filter((row) => normalizeForCompare(row.sessionId) === needle);
  if (excludedExact.length > 0) {
    return failure(
      'not-targetable',
      `session "${excludedExact[0].sessionId}" is a subagent Session; subagent Sessions are driven by their parent, not by the session bus`,
      excludedExact,
    );
  }

  const rungs = [
    {
      how: 'id',
      matches: targetable.filter((row) => normalizeForCompare(row.sessionId) === needle),
    },
    {
      how: 'id-prefix',
      matches: raw.length >= MIN_ID_PREFIX
        ? targetable.filter((row) => normalizeForCompare(row.sessionId).startsWith(needle))
        : [],
    },
    {
      how: 'title',
      matches: targetable.filter((row) => normalizeForCompare(row.title) === needle && normalizeForCompare(row.title) !== ''),
    },
    {
      how: 'title-contains',
      matches: targetable.filter((row) => normalizeForCompare(row.title).includes(needle)),
    },
    {
      how: 'cwd',
      matches: targetable.filter((row) => normalizeForCompare(row.cwd).includes(needle)),
    },
    {
      how: 'id-contains',
      matches: targetable.filter((row) => normalizeForCompare(row.sessionId).includes(needle)),
    },
  ];

  for (const rung of rungs) {
    if (rung.matches.length === 1) return { ok: true, row: rung.matches[0], how: rung.how };
    if (rung.matches.length > 1) {
      return failure(
        'ambiguous',
        `"${raw}" matches ${rung.matches.length} Sessions by ${rung.how}; use the exact sessionId`,
        rung.matches,
      );
    }
  }
  return failure('not-found', `no targetable Session matches "${raw}"`, []);
}

/** Build one resolution failure value. */
function failure(reason, message, candidates) {
  return {
    ok: false,
    reason,
    message,
    candidates: candidates.slice(0, 8).map((row) => ({
      sessionId: row.sessionId,
      title: row.title ?? null,
      cwd: row.cwd ?? null,
    })),
  };
}

/**
 * Resolve a workspace reference against the registered workspaces.
 * @param {Array<{id: string, path: string, title?: string}>} workspaces - registered workspaces.
 * @param {string} query - workspace title, id, or path (exact or substring).
 * @returns {{ok: true, workspace: object, how: string} | {ok: false, reason: string, message: string}}
 */
export function resolveWorkspaceQuery(workspaces, query) {
  const raw = typeof query === 'string' ? query.trim() : '';
  if (raw === '') return { ok: false, reason: 'empty', message: 'the workspace reference must not be empty' };
  const needle = normalizeForCompare(raw);
  const rungs = [
    { how: 'id', matches: workspaces.filter((item) => normalizeForCompare(item.id) === needle) },
    { how: 'path', matches: workspaces.filter((item) => normalizeForCompare(item.path) === needle) },
    { how: 'title', matches: workspaces.filter((item) => normalizeForCompare(item.title) === needle) },
    { how: 'path-contains', matches: workspaces.filter((item) => normalizeForCompare(item.path).includes(needle)) },
    { how: 'title-contains', matches: workspaces.filter((item) => normalizeForCompare(item.title).includes(needle)) },
  ];
  for (const rung of rungs) {
    if (rung.matches.length === 1) return { ok: true, workspace: rung.matches[0], how: rung.how };
    if (rung.matches.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        message: `"${raw}" matches ${rung.matches.length} workspaces by ${rung.how}; use the exact workspace path`,
      };
    }
  }
  return { ok: false, reason: 'not-found', message: `no registered workspace matches "${raw}"` };
}

/**
 * Whether two working directories denote the same location.
 * @param {string|undefined} left - first directory.
 * @param {string|undefined} right - second directory.
 * @returns {boolean} true when both are known and equal after normalization.
 */
export function sameWorkspace(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return normalizeForCompare(left) === normalizeForCompare(right);
}
