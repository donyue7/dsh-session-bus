/**
 * Workspace write leases.
 *
 * A `write_scopes` list on a bus message says "these files are mine", but it
 * does not stop two Sessions that share one working directory from opening the
 * same file at the same time. A lease is a short-lived, shared claim on a set of
 * path prefixes: other Sessions can see who is writing what before they start,
 * the bus refuses a claim that overlaps a live lease held by another Session
 * (unless the caller explicitly forces it), and a lease expires on its own so a
 * crashed or abandoned Session can never lock a workspace forever.
 *
 * Leases store path prefixes, not open files and not OS locks: they are
 * coordination, not enforcement. The caller is expected to claim, do the work,
 * announce the result, and release.
 *
 * @module dsh-session-bus/leases
 */

import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve, sep } from 'node:path';

/** Upper bound on remembered leases; expired ones are pruned first. */
const MAX_LEASES = 300;

/** How long a lapsed lease is kept visible to `include_expired` listings. */
const EXPIRED_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Windows paths are case-insensitive; POSIX paths are not. */
const CASE_INSENSITIVE = process.platform === 'win32';

/**
 * Resolve one lease path against a workspace and normalize its separators.
 *
 * The result is what the tool output shows: an absolute path with no trailing
 * separator. Case is preserved so it stays readable on Windows.
 * @param {string} value - absolute or workspace-relative path.
 * @param {string} [workspace] - base directory for relative paths.
 * @returns {string} absolute display path.
 */
export function leasePath(value, workspace) {
  const base = typeof workspace === 'string' && workspace !== '' ? workspace : process.cwd();
  let display = isAbsolute(value) ? value : resolve(base, value);
  if (sep === '\\') display = display.replace(/\//g, '\\');
  while (display.length > 1 && display.endsWith(sep)) display = display.slice(0, -1);
  return display;
}

/**
 * The comparison key of one lease path.
 *
 * Two roots overlap when one is the other or sits below it; comparing
 * normalized, platform-cased keys is what makes that test cheap and stable.
 * @param {string} value - absolute or workspace-relative path.
 * @param {string} [workspace] - base directory for relative paths.
 * @returns {string} normalized comparison key.
 */
export function leaseKey(value, workspace) {
  const display = leasePath(value, workspace);
  return CASE_INSENSITIVE ? display.toLowerCase() : display;
}

/**
 * Whether two lease roots cover at least one common path.
 * @param {string} left - normalized root.
 * @param {string} right - normalized root.
 * @returns {boolean} true when one root is the other or an ancestor of it.
 */
export function leaseRootsOverlap(left, right) {
  if (left === right) return true;
  const boundaryLeft = left.endsWith(sep) ? left : `${left}${sep}`;
  const boundaryRight = right.endsWith(sep) ? right : `${right}${sep}`;
  return boundaryLeft.startsWith(boundaryRight) || boundaryRight.startsWith(boundaryLeft);
}

/**
 * The shared write-lease ledger.
 *
 * Persisted next to the thread ledger so a Host restart keeps active claims;
 * tests construct it directly with a fake clock.
 */
export class LeaseLedger {
  /** @type {Map<string, object>} leaseId -> lease record. */
  #leases = new Map();

  /**
   * @param {object} [options] - ledger options.
   * @param {() => number} [options.clock] - epoch-millisecond clock (tests).
   */
  constructor({ clock } = {}) {
    this.clock = typeof clock === 'function' ? clock : () => Date.now();
  }

  /**
   * Claim a set of paths for one Session.
   *
   * Claiming the same paths again renews the existing lease instead of growing
   * the ledger. A conflicting claim held by another Session fails unless
   * `force` is set; the conflicts are returned either way so the caller and the
   * audit log know what was overridden.
   * @param {object} input - claim request.
   * @param {string} input.sessionId - claimant Session id.
   * @param {string} input.workspace - claimant working directory.
   * @param {string[]} input.paths - absolute or workspace-relative paths.
   * @param {string} [input.note] - why these paths are claimed.
   * @param {number} input.ttlMs - lifetime in milliseconds.
   * @param {boolean} [input.force] - claim despite another Session's lease.
   * @returns {{granted: boolean, lease?: object, conflicts: Array<{lease: object, overlap: string[]}>}} claim result.
   */
  acquire({ sessionId, workspace, paths, note, ttlMs, force }) {
    const now = this.clock();
    const requested = [...new Set(paths.map((path) => leaseKey(path, workspace)))];
    const conflicts = [];
    for (const lease of this.#leases.values()) {
      if (lease.sessionId === sessionId || lease.expiresAt <= now) continue;
      const overlap = requested.filter((root) => lease.roots.some((known) => leaseRootsOverlap(root, known)));
      if (overlap.length > 0) conflicts.push({ lease, overlap });
    }
    if (conflicts.length > 0 && force !== true) return { granted: false, conflicts };

    // Idempotent renew: a Session claiming the same paths again extends its own
    // lease instead of accumulating duplicates.
    for (const lease of this.#leases.values()) {
      if (lease.sessionId !== sessionId || lease.expiresAt <= now) continue;
      if (sameRoots(lease.roots, requested)) {
        lease.updatedAt = now;
        lease.expiresAt = now + ttlMs;
        if (note !== undefined) lease.note = note;
        return { granted: true, lease, conflicts };
      }
    }

    const lease = {
      leaseId: `l-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      sessionId,
      workspace,
      paths: paths.map((path) => leasePath(path, workspace)),
      roots: requested,
      ...note === undefined ? {} : { note },
      createdAt: now,
      updatedAt: now,
      expiresAt: now + ttlMs,
    };
    this.#leases.set(lease.leaseId, lease);
    this.#prune(now);
    return { granted: true, lease, conflicts };
  }

  /**
   * Release one lease, or every lease of one Session.
   * @param {object} input - release request.
   * @param {string} input.sessionId - owner Session id.
   * @param {string} [input.leaseId] - lease to release.
   * @param {boolean} [input.all] - release every lease this Session holds.
   * @returns {{released: string[], missing: string[]}} released and unknown ids.
   */
  release({ sessionId, leaseId, all }) {
    const released = [];
    const missing = [];
    if (all === true) {
      for (const [id, lease] of this.#leases.entries()) {
        if (lease.sessionId !== sessionId) continue;
        this.#leases.delete(id);
        released.push(id);
      }
      return { released, missing };
    }
    const known = typeof leaseId === 'string' ? this.#leases.get(leaseId) : undefined;
    if (known === undefined || known.sessionId !== sessionId) {
      if (typeof leaseId === 'string' && leaseId !== '') missing.push(leaseId);
      return { released, missing };
    }
    this.#leases.delete(leaseId);
    released.push(leaseId);
    return { released, missing };
  }

  /**
   * List leases, newest activity first.
   * @param {object} [options] - listing options.
   * @param {boolean} [options.includeExpired] - include lapsed leases.
   * @returns {object[]} lease records with computed age fields.
   */
  list({ includeExpired = false } = {}) {
    const now = this.clock();
    return [...this.#leases.values()]
      .filter((lease) => includeExpired === true || lease.expiresAt > now)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((lease) => ({
        ...lease,
        expired: lease.expiresAt <= now,
        ageMinutes: Math.max(0, Math.round((now - lease.createdAt) / 60000)),
        expiresInMinutes: Math.max(0, Math.round((lease.expiresAt - now) / 60000)),
      }));
  }

  /** Snapshot for the persisted bus state. */
  toJSON() {
    return { leases: [...this.#leases.values()] };
  }

  /**
   * Adopt a snapshot written by an earlier Host process.
   * @param {object} [data] - snapshot from {@link LeaseLedger#toJSON}.
   * @returns {void}
   */
  restore(data) {
    if (data === null || typeof data !== 'object') return;
    const leases = Array.isArray(data.leases) ? data.leases : [];
    for (const lease of leases) {
      if (lease === null || typeof lease !== 'object') continue;
      if (typeof lease.leaseId !== 'string' || typeof lease.sessionId !== 'string') continue;
      if (!Array.isArray(lease.roots) || !Array.isArray(lease.paths)) continue;
      this.#leases.set(lease.leaseId, lease);
    }
    this.#prune(this.clock());
  }

  /** Keep the ledger bounded: forget stale expired leases, then oldest first. */
  #prune(now) {
    for (const [id, lease] of this.#leases.entries()) {
      if (lease.expiresAt <= now - EXPIRED_RETENTION_MS) this.#leases.delete(id);
    }
    if (this.#leases.size <= MAX_LEASES) return;
    const oldest = [...this.#leases.values()]
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .slice(0, this.#leases.size - MAX_LEASES);
    for (const lease of oldest) this.#leases.delete(lease.leaseId);
  }
}

/** Whether two root lists contain exactly the same entries. */
function sameRoots(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((root) => set.has(root));
}
