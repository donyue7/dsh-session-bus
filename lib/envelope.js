/**
 * The session-bus wire envelope.
 *
 * Every message delivered by the bus is a plain user message whose first line
 * is a machine-readable header. The header tells a receiving Session that the
 * message came from another Session, which Session to answer, which
 * conversation it belongs to, and how many hops that conversation has already
 * travelled (loop protection).
 *
 * Layout (every attribute after `msg` is optional, so a header written by an
 * older peer still parses):
 *
 *   [session-bus v1] from=session-abc hop=1/8 msg=1f0c9a2b re=9d3c11 thread=t-4a7b21c9
 *   from-title: Fix the parser
 *   from-cwd: C:\work\project-a
 *   sent-at: 2026-10-16T05:10:04.000Z
 *   write-scopes: frontend/src/views, backend/app/services
 *   body-file: C:\Users\me\.dsh-harness-next\session-bus\spool\1f0c9a2b.md
 *   body-bytes: 41233
 *   --- message ---
 *   please run the test suite and tell me the failures
 *   --- reply ---
 *   Reply with the bus_send tool: ...
 *
 * @module dsh-session-bus/envelope
 */

/** Envelope schema version written into the header line. */
export const ENVELOPE_VERSION = 1;

/** Prefix every bus header starts with. */
const HEADER_PREFIX = /^\[session-bus v(\d+)\]\s*/;

/** Metadata line: `key: value`. */
const META_RE = /^([a-z-]+):\s?(.*)$/;

/** Attribute names the header may carry. */
const HEADER_KEYS = new Set(['from', 'hop', 'msg', 're', 'thread']);

/**
 * Render the envelope that wraps one bus message.
 * @param {object} input - envelope fields.
 * @param {string} input.fromId - sender Session id (the reply address).
 * @param {string} [input.fromTitle] - sender Session title, for human context.
 * @param {string} [input.fromCwd] - sender working directory, for human context.
 * @param {number} input.hop - 1-based hop count of this message within its thread.
 * @param {number} input.maxHops - hop budget configured for this instance.
 * @param {string} input.messageId - stable id of this message (delivery idempotency key).
 * @param {string} [input.replyTo] - id of the message this one answers.
 * @param {string} [input.threadId] - conversation id shared by every hop.
 * @param {string} input.time - ISO timestamp of the send.
 * @param {string} input.text - the sender's message body (or a pointer to a spooled body).
 * @param {string[]} [input.writeScopes] - paths the receiver may write, and everything else it must not.
 * @param {string} [input.bodyFile] - absolute path of the spooled full body.
 * @param {number} [input.bodyBytes] - byte length of the spooled full body.
 * @param {string} [input.replyTool] - tool name the receiver should answer with.
 * @returns {string} the complete message text to admit as a user message.
 */
export function renderEnvelope(input) {
  const replyTool = input.replyTool ?? 'bus_send';
  const attributes = [
    `from=${input.fromId}`,
    `hop=${input.hop}/${input.maxHops}`,
    `msg=${input.messageId}`,
  ];
  if (typeof input.replyTo === 'string' && input.replyTo !== '') attributes.push(`re=${input.replyTo}`);
  if (typeof input.threadId === 'string' && input.threadId !== '') attributes.push(`thread=${input.threadId}`);
  const header = `[session-bus v${ENVELOPE_VERSION}] ${attributes.join(' ')}`;

  // Only advertise metadata that actually exists; a placeholder would be read
  // back as if it were a real title or path.
  const meta = [];
  const title = oneLine(input.fromTitle);
  const cwd = oneLine(input.fromCwd);
  if (title !== '') meta.push(`from-title: ${title}`);
  if (cwd !== '') meta.push(`from-cwd: ${cwd}`);
  meta.push(`sent-at: ${input.time}`);
  const scopes = Array.isArray(input.writeScopes)
    ? input.writeScopes.filter((scope) => typeof scope === 'string' && scope.trim() !== '')
    : [];
  if (scopes.length > 0) meta.push(`write-scopes: ${scopes.map((scope) => oneLine(scope)).join(', ')}`);
  if (typeof input.bodyFile === 'string' && input.bodyFile !== '') meta.push(`body-file: ${input.bodyFile}`);
  if (typeof input.bodyBytes === 'number') meta.push(`body-bytes: ${input.bodyBytes}`);

  const reply = [
    `You received this because another Session pushed it through the DSH session bus.`,
    `Answer with the ${replyTool} tool: ${replyTool}({ to: "${input.fromId}", message: "<your result>" }).`,
    `Pass thread: "${input.threadId}" (and re: "${input.messageId}") so the sender can match your answer to this request.`,
    `Never reply only to acknowledge receipt; reply when you have a result, or report that you are blocked.`,
    `请用 ${replyTool} 工具把结果发回会话 ${input.fromId}，并带上 thread: "${input.threadId}"；不要只为确认收到而回复。`,
    scopes.length > 0
      ? `Write scope for this task: ${scopes.join(', ')} — do not modify files outside it; other Sessions may be working in the same workspace.`
      : `If other Sessions share your working directory, keep writes inside the scope this message names, or ask before touching shared files.`,
  ].join('\n');

  return `${header}\n${meta.join('\n')}\n--- message ---\n${input.text}\n--- reply ---\n${reply}\n`;
}

/**
 * Parse a bus envelope out of arbitrary message text.
 * @param {string} text - candidate message text (raw user message content).
 * @returns {{version: number, from: string, hop: number, maxHops: number, messageId: string, replyTo?: string, threadId?: string, fromTitle?: string, fromCwd?: string, sentAt?: string, writeScopes?: string[], bodyFile?: string, bodyBytes?: number, body?: string} | undefined}
 *   the parsed envelope, or `undefined` when the text is not a bus message.
 */
export function parseEnvelope(text) {
  if (typeof text !== 'string') return undefined;
  // Tolerate leading blank lines so a prefixed message still parses.
  const trimmed = text.replace(/^[\s\uFEFF]+/, '');
  const lines = trimmed.split(/\r?\n/);
  const first = lines[0] ?? '';
  const prefix = HEADER_PREFIX.exec(first);
  if (prefix === null) return undefined;
  const result = { version: Number(prefix[1]) };
  // Attribute order is not guaranteed across versions, so read them by name and
  // ignore anything unrecognized instead of matching one fixed shape.
  for (const token of first.slice(prefix[0].length).split(/\s+/)) {
    if (token === '') continue;
    const at = token.indexOf('=');
    if (at <= 0) continue;
    const key = token.slice(0, at);
    const value = token.slice(at + 1);
    if (!HEADER_KEYS.has(key)) continue;
    if (key === 'hop') {
      const [hop, maxHops] = value.split('/');
      result.hop = Number(hop);
      result.maxHops = Number(maxHops);
    } else if (key === 'msg') result.messageId = value;
    else if (key === 're') result.replyTo = value;
    else if (key === 'thread') result.threadId = value;
    else if (key === 'from') result.from = value;
  }
  if (typeof result.from !== 'string' || typeof result.messageId !== 'string') return undefined;

  const scopes = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('---')) break;
    const meta = META_RE.exec(line);
    if (meta === null) break;
    if (meta[1] === 'from-title') result.fromTitle = meta[2];
    else if (meta[1] === 'from-cwd') result.fromCwd = meta[2];
    else if (meta[1] === 'sent-at') result.sentAt = meta[2];
    else if (meta[1] === 'body-file') result.bodyFile = meta[2];
    else if (meta[1] === 'body-bytes') result.bodyBytes = Number(meta[2]);
    else if (meta[1] === 'write-scopes') {
      for (const scope of meta[2].split(',')) if (scope.trim() !== '') scopes.push(scope.trim());
    }
  }
  if (scopes.length > 0) result.writeScopes = scopes;

  const bodyStart = lines.findIndex((line) => line.trim() === '--- message ---');
  if (bodyStart !== -1) {
    const bodyEnd = lines.findIndex((line, at) => at > bodyStart && line.trim() === '--- reply ---');
    const bodyLines = lines.slice(bodyStart + 1, bodyEnd === -1 ? undefined : bodyEnd);
    result.body = bodyLines.join('\n').replace(/\s+$/, '');
  }
  return result;
}

/** Collapse a value to a single trimmed line, or the empty string. */
function oneLine(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n]+/g, ' ').trim();
}
