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
 *   [session-bus v1] from=session-abc hop=1/16 msg=1f0c9a2b re=9d3c11 thread=t-4a7b21c9
 *   from-title: Fix the parser
 *   from-cwd: C:\work\project-a
 *   sent-at: 2026-10-16T05:10:04.000Z
 *   kind: conclusion
 *   closing: true
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
const HEADER_KEYS = new Set(['from', 'hop', 'msg', 're', 'thread', 'mode']);

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
 * @param {string} [input.mode] - delivery mode; `'interrupt'` is advertised in the
 *   header, and `'queue'` adds a "written time is not delivery time" reminder.
 * @param {string} [input.kind] - optional message kind (`task`, `conclusion`, `correction`,
 *   `question`, `notice`, `ack`) shown in the metadata and in the interrupt reminder.
 * @param {boolean} [input.closing] - true when the sender is closing the conversation and
 *   does not expect an answer.
 * @param {number} [input.hopRemaining] - hops left in the budget; a low number earns a warning.
 * @param {string[]} [input.writeScopes] - paths the receiver may write, and everything else it must not.
 * @param {string} [input.bodyFile] - absolute path of the spooled full body.
 * @param {number} [input.bodyBytes] - byte length of the spooled full body.
 * @param {string} [input.replyTool] - tool name the receiver should answer with.
 * @param {object} [input.payload] - machine-readable structured result, rendered as a
 *   `--- payload ---` JSON section so the receiver can parse instead of re-reading prose.
 * @param {Array<{path: string, sha256?: string, note?: string}>} [input.attachments] - files
 *   the receiver should read by path, rendered as a `--- attachments ---` section.
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
  if (input.mode === 'interrupt') attributes.push('mode=interrupt');
  const header = `[session-bus v${ENVELOPE_VERSION}] ${attributes.join(' ')}`;

  // Only advertise metadata that actually exists; a placeholder would be read
  // back as if it were a real title or path.
  const meta = [];
  const title = oneLine(input.fromTitle);
  const cwd = oneLine(input.fromCwd);
  if (title !== '') meta.push(`from-title: ${title}`);
  if (cwd !== '') meta.push(`from-cwd: ${cwd}`);
  meta.push(`sent-at: ${input.time}`);
  if (typeof input.kind === 'string' && input.kind !== '') meta.push(`kind: ${oneLine(input.kind)}`);
  if (input.closing === true) meta.push('closing: true');
  const scopes = Array.isArray(input.writeScopes)
    ? input.writeScopes.filter((scope) => typeof scope === 'string' && scope.trim() !== '')
    : [];
  if (scopes.length > 0) meta.push(`write-scopes: ${scopes.map((scope) => oneLine(scope)).join(', ')}`);
  if (typeof input.bodyFile === 'string' && input.bodyFile !== '') meta.push(`body-file: ${input.bodyFile}`);
  if (typeof input.bodyBytes === 'number') meta.push(`body-bytes: ${input.bodyBytes}`);

  const closing = input.closing === true;
  const kindLabel = typeof input.kind === 'string' && input.kind !== '' ? ` (${input.kind})` : '';
  const interruptLine =
    input.mode === 'interrupt'
      ? [
          `This message is an interrupt${kindLabel}: it may reach you while your current turn is still running. Treat it as newer information than the task you started, and adapt before your next step — do not finish the turn on the old assumption.`,
        ]
      : [];
  const reply = [
    `You received this because another Session pushed it through the DSH session bus.`,
    ...(closing
      ? ['This message closes the conversation: do not answer it; the sender does not expect a reply.']
      : [
          `Answer with the ${replyTool} tool: ${replyTool}({ to: "${input.fromId}", message: "<your result>" }).`,
          `Pass thread: "${input.threadId}" (and re: "${input.messageId}") so the sender can match your answer to this request.`,
        ]),
    ...interruptLine,
    ...(closing
      ? []
      : [
          `Never reply only to acknowledge receipt; reply when you have a result, or report that you are blocked.`,
          `请用 ${replyTool} 工具把结果发回会话 ${input.fromId}，并带上 thread: "${input.threadId}"；不要只为确认收到而回复。`,
        ]),
    ...(closing === false && typeof input.hopRemaining === 'number' && input.hopRemaining <= 2
      ? [
          `Hop budget: ${input.hopRemaining} of ${input.maxHops} left in this conversation; finish with a conclusion rather than another round, or raise the budget with max_hops.`,
        ]
      : []),
    ...(input.mode === 'queue' && closing === false
      ? [
          `sent-at is when this was written, not necessarily when it reached you; if it waited behind your turn, check the current state before acting on it.`,
        ]
      : []),
    scopes.length > 0
      ? `Write scope for this task: ${scopes.join(', ')} — do not modify files outside it; other Sessions may be working in the same workspace.`
      : `If other Sessions share your working directory, keep writes inside the scope this message names, or ask before touching shared files.`,
  ].join('\n');

  const payloadSection =
    input.payload === undefined ? '' : `--- payload ---\n${JSON.stringify(input.payload, null, 2)}\n`;
  const attachmentSection =
    Array.isArray(input.attachments) && input.attachments.length > 0
      ? `--- attachments ---\n${input.attachments
          .map((attachment) => {
            const sha = typeof attachment.sha256 === 'string' && attachment.sha256 !== '' ? ` (sha256: ${attachment.sha256})` : '';
            const note = typeof attachment.note === 'string' && attachment.note !== '' ? ` — ${attachment.note}` : '';
            return `- ${attachment.path}${sha}${note}`;
          })
          .join('\n')}\n`
      : '';

  return `${header}\n${meta.join('\n')}\n--- message ---\n${input.text}\n${payloadSection}${attachmentSection}--- reply ---\n${reply}\n`;
}

/**
 * Parse a bus envelope out of arbitrary message text.
 * @param {string} text - candidate message text (raw user message content).
 * @returns {{version: number, from: string, hop: number, maxHops: number, messageId: string, replyTo?: string, threadId?: string, mode?: string, kind?: string, closing?: boolean, fromTitle?: string, fromCwd?: string, sentAt?: string, writeScopes?: string[], bodyFile?: string, bodyBytes?: number, body?: string, payload?: object, attachments?: Array<{path: string, sha256?: string, note?: string}>} | undefined}
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
    else if (key === 'mode') result.mode = value;
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
    else if (meta[1] === 'kind') result.kind = meta[2];
    else if (meta[1] === 'closing') result.closing = meta[2] === 'true';
    else if (meta[1] === 'body-file') result.bodyFile = meta[2];
    else if (meta[1] === 'body-bytes') result.bodyBytes = Number(meta[2]);
    else if (meta[1] === 'write-scopes') {
      for (const scope of meta[2].split(',')) if (scope.trim() !== '') scopes.push(scope.trim());
    }
  }
  if (scopes.length > 0) result.writeScopes = scopes;

  const bodyLines = sectionLines(lines, 'message');
  if (bodyLines !== undefined) result.body = bodyLines.join('\n').replace(/\s+$/, '');

  const payloadLines = sectionLines(lines, 'payload');
  if (payloadLines !== undefined) {
    try {
      result.payload = JSON.parse(payloadLines.join('\n'));
    } catch {
      // A malformed payload section is a sender bug; the readable message still stands.
    }
  }

  const attachmentLines = sectionLines(lines, 'attachments');
  if (attachmentLines !== undefined) {
    const attachments = [];
    for (const line of attachmentLines) {
      const match = /^-\s+(.*\S)\s*$/.exec(line);
      if (match === null) continue;
      attachments.push(parseAttachment(match[1]));
    }
    if (attachments.length > 0) result.attachments = attachments;
  }
  return result;
}

/**
 * The lines of one `--- section ---` block, or `undefined` when it is absent.
 *
 * The envelope is line-oriented, so a section ends at the next section marker;
 * a message body that never used sections (older peers) keeps parsing exactly
 * as before.
 * @param {string[]} lines - envelope lines.
 * @param {string} name - section name without the surrounding dashes.
 * @returns {string[]|undefined} the section lines, markers excluded.
 */
function sectionLines(lines, name) {
  const marker = `--- ${name} ---`;
  const start = lines.findIndex((line) => line.trim() === marker);
  if (start === -1) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^--- .+ ---$/.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

/** Parse one `- <path> [(sha256: <hash>)] [— <note>]` attachment line. */
function parseAttachment(text) {
  let rest = text.trim();
  let note;
  const dash = rest.indexOf(' — ');
  if (dash !== -1) {
    note = rest.slice(dash + 3).trim();
    rest = rest.slice(0, dash).trim();
  }
  let sha256;
  const sha = /^(.+?) \(sha256: ([0-9a-f]{64})\)$/i.exec(rest);
  if (sha !== null) {
    rest = sha[1].trim();
    sha256 = sha[2].toLowerCase();
  }
  const attachment = { path: rest };
  if (sha256 !== undefined) attachment.sha256 = sha256;
  if (note !== undefined && note !== '') attachment.note = note;
  return attachment;
}

/** Collapse a value to a single trimmed line, or the empty string. */
function oneLine(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n]+/g, ' ').trim();
}
