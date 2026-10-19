/**
 * Model-facing tools of the session bus.
 *
 * Four tools cover the whole feature:
 *   - `bus_list`  discover Sessions that can be reached
 *   - `bus_send`  push a message into one, waking it
 *   - `bus_read`  read the recent transcript of one (collect an answer)
 *   - `bus_spawn` create a new Session in a workspace and push its first message
 *
 * Schemas are written as plain JSON Schema because the plugin imports no
 * packages beyond `node:*` (see `toolkit.js` for why that matters).
 *
 * @module dsh-session-bus/tools
 */

import { defineTool } from './toolkit.js';

/** How long a sender identity is cached per Session before it is read again. */
const SENDER_CACHE_MS = 60000;

/**
 * Register every session-bus tool on the plugin context.
 * @param {object} ctx - plugin context carrying `tools`.
 * @param {import('./bus.js').SessionBus} bus - the bus core.
 * @returns {void}
 */
export function registerTools(ctx, bus) {
  const cache = new Map();

  /** Describe the Session that is calling a tool. */
  const senderOf = (exec) => {
    const agent = exec.agent;
    const session = agent?.session;
    const id = typeof agent?.id === 'string' ? agent.id : undefined;
    const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined;
    if (id === undefined) return { id: undefined, title: undefined, cwd, preset: undefined };
    const cached = cache.get(id);
    if (cached !== undefined && Date.now() - cached.at < SENDER_CACHE_MS) {
      return { id, title: cached.title, cwd, preset: cached.preset };
    }
    const found = scanSessionIdentity(session);
    cache.set(id, { ...found, at: Date.now() });
    if (cache.size > 256) cache.delete(cache.keys().next().value);
    return { id, title: found.title, cwd, preset: found.preset };
  };

  /** Bound one tool call by the configured delivery budget. */
  const deadline = (exec) => withDeadline(exec.signal, bus.config.deliveryTimeoutMs);

  ctx.tools.register(defineTool({
    name: 'bus_list',
    description:
      'List the DSH Sessions this Host can see, newest activity first. Each row carries the exact sessionId to use with bus_send, its title, its working directory, and whether it is busy. Use it to find the Session you want to hand work to, including Sessions in other workspaces.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Optional case-insensitive filter applied to sessionId, title, and working directory.' },
        include_subagents: {
          type: 'boolean',
          description: 'Include subagent-owned Sessions. They are listed for orientation only and cannot receive bus messages. Defaults to false.',
        },
        limit: { type: 'integer', description: 'Maximum rows to return. Defaults to the configured list limit (40).' },
        offset: { type: 'integer', description: 'Rows to skip, for paging past the first page.' },
        updated_within_minutes: { type: 'integer', description: 'Keep only Sessions with activity inside this window, in minutes.' },
        active_only: {
          type: 'boolean',
          description: 'Keep only Sessions that already share a bus thread with you. Defaults to false.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', description: 'Number of Sessions matching the filter.' },
          returned: { type: 'integer', description: 'Rows in this page.' },
          offset: { type: 'integer', description: 'Offset this page started at.' },
          hasMore: { type: 'boolean', description: 'Whether another page exists beyond this one.' },
          sessions: {
            type: 'array',
            description: 'Matching Sessions, newest activity first.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                title: { type: 'string' },
                cwd: { type: 'string' },
                running: { type: 'boolean' },
                targetable: { type: 'boolean' },
                isSelf: { type: 'boolean' },
                isSubagent: { type: 'boolean' },
                sameCwdAsCaller: { type: 'boolean', description: 'True when this Session works in your own working directory, so writes can collide.' },
                updatedAtIso: { type: 'string' },
              },
              required: ['sessionId', 'running', 'targetable', 'isSelf', 'isSubagent', 'updatedAtIso'],
            },
          },
        },
        required: ['total', 'sessions'],
      },
      render: (_args, value) => [{ type: 'text', text: renderList(value) }],
    },
    async execute(args, exec) {
      const sender = senderOf(exec);
      const result = await bus.list({
        query: args.query,
        includeSubagents: args.include_subagents === true,
        limit: args.limit,
        offset: args.offset,
        updatedWithinMinutes: args.updated_within_minutes,
        activeOnly: args.active_only === true,
        selfId: sender.id,
        selfCwd: sender.cwd,
        signal: deadline(exec),
      });
      return result;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'bus_send',
    description:
      'Push a message into another DSH Session and wake it. The target Session is resumed automatically if it is cold, and the message wakes it exactly like typed input: an idle Session starts a new turn, a busy Session receives it when its current turn ends (mode "queue") or immediately (mode "steer"). By default the message is recorded with the DSH `agent-message` source, so the receiving Web UI shows it as a non-human "task message received" card rather than a right-aligned bubble that looks like the local user typed it. Use this instead of asking the user to stop a Session and paste text into it. The receiving Session does not share your conversation, so write a self-contained message, and expect the answer as a new bus message or read it with bus_read.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        to: {
          type: 'string',
          description: 'Target Session: an exact sessionId from bus_list, a unique sessionId prefix, a unique title or working-directory substring, or "self".',
        },
        message: {
          type: 'string',
          description: 'The message to push. Include everything the other Session needs: the goal, the relevant paths, and how to report back.',
        },
        mode: {
          type: 'string',
          enum: ['queue', 'steer'],
          description: 'Delivery mode. "queue" (default) waits behind a running turn; "steer" injects into the running turn immediately.',
        },
        force: {
          type: 'boolean',
          description: 'Deliver even though this conversation exceeded the hop budget. Use only for a deliberate long exchange.',
        },
        thread: {
          type: 'string',
          description: 'Conversation id to continue, from a previous receipt or from an inbound envelope. Omit and the bus continues the thread automatically when you answer the peer that last wrote to you; anything else starts a new conversation.',
        },
        reply_to: {
          type: 'string',
          description: 'Message id this send answers (the `msg=` value of the inbound envelope). Pins the reply to that conversation.',
        },
        write_scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths this task may write, for example ["frontend/src/views"]. Written into the envelope and the audit log so a Session sharing your working directory knows which files are not yours.',
        },
        elevate: {
          type: 'boolean',
          description: 'Set false to leave the target Session on its own permission preset. Defaults to true, which delegates your preset when the target is more restricted.',
        },
      },
      required: ['to', 'message'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean' },
          sessionId: { type: 'string' },
          title: { type: 'string' },
          cwd: { type: 'string' },
          mode: { type: 'string' },
          messageId: { type: 'string' },
          threadId: { type: 'string', description: 'Conversation id; pass it back when answering so the sender can match the reply.' },
          replyTo: { type: 'string', description: 'Message id this delivery answers, when it continued a thread.' },
          hop: { type: 'integer' },
          hopBudget: { type: 'integer' },
          hopRemaining: { type: 'integer', description: 'Hop budget left in this conversation.' },
          targetRunning: { type: 'boolean' },
          crossWorkspace: { type: 'boolean' },
          permission: { type: 'string', description: 'Permission preset now in force for the target Session.' },
          spooled: { type: 'boolean', description: 'True when the body was too long and was written to a spool file instead.' },
          note: { type: 'string' },
        },
        required: ['delivered', 'sessionId', 'mode', 'messageId', 'hop', 'hopBudget', 'targetRunning', 'crossWorkspace', 'note'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Delivered to ${value.sessionId}${value.title === undefined ? '' : ` "${value.title}"`}${value.cwd === undefined ? '' : ` @ ${value.cwd}`}.`,
          `mode=${value.mode} thread=${value.threadId} hop=${value.hop}/${value.hopBudget} (${value.hopRemaining ?? 0} left) msg=${value.messageId}${value.replyTo === undefined ? '' : ` re=${value.replyTo}`}${value.crossWorkspace ? ' cross-workspace' : ''}${value.permission === undefined ? '' : ` permission=${value.permission}`}${value.spooled === true ? ' body-spooled' : ''}`,
          value.note,
        ].join('\n'),
      }],
    },
    async execute(args, exec) {
      const sender = senderOf(exec);
      const receipt = await bus.send({
        to: args.to,
        message: args.message,
        mode: args.mode,
        force: args.force === true,
        threadId: args.thread,
        replyTo: args.reply_to,
        writeScopes: args.write_scopes,
        elevate: args.elevate,
        sender,
        signal: deadline(exec),
      });
      return receipt;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'bus_read',
    description:
      'Read the tail of another DSH Session transcript: its latest user and assistant messages, with bus messages marked. Use it to collect the answer to a bus_send when the other Session cannot or did not reply, or to check what it is doing. Reading never wakes the target Session.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session: {
          type: 'string',
          description: 'Target Session: an exact sessionId, a unique prefix, a unique title or working-directory substring, or "self".',
        },
        limit: { type: 'integer', description: 'Maximum number of messages to return, counted from the end. Defaults to 12.' },
        max_chars: { type: 'integer', description: 'Approximate character budget for the returned text. Defaults to 8000.' },
        since: {
          type: 'string',
          description: 'Return only messages newer than this: a bus message id from an earlier receipt or envelope, or an ISO-8601 timestamp. Use it to poll for an answer without re-reading what you already saw.',
        },
      },
      required: ['session'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string' },
          cwd: { type: 'string' },
          running: { type: 'boolean' },
          since: { type: 'string', description: 'Resolved lower bound of this incremental read, or absent for a full tail read.' },
          returned: { type: 'integer' },
          totalEvents: { type: 'integer' },
          truncated: { type: 'boolean' },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                role: { type: 'string' },
                at: { type: 'string' },
                viaBus: { type: 'boolean' },
                text: { type: 'string' },
              },
              required: ['role', 'at', 'viaBus', 'text'],
            },
          },
        },
        required: ['sessionId', 'running', 'returned', 'totalEvents', 'truncated', 'messages'],
      },
      render: (_args, value) => [{ type: 'text', text: renderTranscript(value) }],
    },
    async execute(args, exec) {
      const sender = senderOf(exec);
      const result = await bus.read({
        session: args.session,
        limit: args.limit,
        maxChars: args.max_chars,
        since: args.since,
        sender,
        signal: deadline(exec),
      });
      return result;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'bus_spawn',
    description:
      'Create a new DSH Session in a workspace and push its first message, so a fresh Session starts working in another working directory without the user opening it. The new Session runs the same agent preset as the caller. Use it when the task belongs in a workspace that has no suitable Session yet; prefer bus_send when an existing Session already fits.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        message: {
          type: 'string',
          description: 'The first message for the new Session. Self-contained: the new Session has no shared context.',
        },
        workspace: {
          type: 'string',
          description: 'Registered workspace to open the Session in: workspace path, title, or id. Defaults to the calling Session workspace.',
        },
        cwd: {
          type: 'string',
          description: 'Absolute working directory when no registered workspace is named.',
        },
        mode: {
          type: 'string',
          enum: ['queue', 'steer'],
          description: 'Delivery mode for the first message. "queue" is the default and is correct for a brand-new Session.',
        },
        spawn_key: {
          type: 'string',
          description: 'Idempotency key. The same key always resolves to the same Session, so a retried or timed-out spawn adopts what the first attempt created instead of leaving a second Session behind.',
        },
      },
      required: ['message'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean' },
          sessionId: { type: 'string' },
          cwd: { type: 'string' },
          mode: { type: 'string' },
          messageId: { type: 'string' },
          hop: { type: 'integer' },
          hopBudget: { type: 'integer' },
          created: { type: 'boolean' },
          permission: { type: 'string', description: 'Permission preset now in force for the new Session.' },
          note: { type: 'string' },
        },
        required: ['delivered', 'sessionId', 'mode', 'messageId', 'hop', 'hopBudget', 'created', 'note'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Created ${value.sessionId}${value.cwd === undefined ? '' : ` @ ${value.cwd}`} and delivered the first message.`,
          `mode=${value.mode} hop=${value.hop}/${value.hopBudget} msg=${value.messageId}${value.permission === undefined ? '' : ` permission=${value.permission}`}`,
          value.note,
        ].join('\n'),
      }],
    },
    async execute(args, exec) {
      const sender = senderOf(exec);
      const receipt = await bus.spawn({
        message: args.message,
        workspace: args.workspace,
        cwd: args.cwd,
        mode: args.mode,
        spawnKey: args.spawn_key,
        preset: sender.preset,
        sender,
        signal: deadline(exec),
      });
      return receipt;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'bus_threads',
    description:
      'List the bus conversations this Session is part of, newest first, with what each one is waiting on. Use it instead of reading peer transcripts to find out which request is still unanswered: `pending: true` means you sent the last message in that thread and the peer has not answered yet, `awaitingYou: true` means the peer is waiting for you. The threadId here is what you pass to bus_send({ thread }) to answer in the right conversation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', description: 'Maximum threads to return, newest first. Defaults to 20.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer' },
          threads: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                threadId: { type: 'string' },
                peer: { type: 'string' },
                hop: { type: 'integer' },
                hopBudget: { type: 'integer' },
                hopRemaining: { type: 'integer' },
                lastMessageId: { type: 'string' },
                lastAt: { type: 'string' },
                awaitingReplyFrom: { type: 'string' },
                pending: { type: 'boolean' },
                awaitingYou: { type: 'boolean' },
              },
              required: ['threadId', 'hop', 'hopBudget', 'hopRemaining', 'lastMessageId', 'lastAt', 'pending', 'awaitingYou'],
            },
          },
        },
        required: ['total', 'threads'],
      },
      render: (_args, value) => [{ type: 'text', text: renderThreads(value) }],
    },
    async execute(args, exec) {
      return bus.threads({ sender: senderOf(exec), limit: args.limit });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'bus_find',
    description:
      'Find the Sessions whose conversations actually discuss a question, across every workspace, before you ask anyone. It searches full Session text (not just titles) and returns the few Sessions whose transcripts match, each with the matching snippet, whether it is busy, and whether you already share a thread. Read-only: it never wakes a Session. When several Sessions are equally plausible, when nothing genuinely matches, or when the snippet does not clearly answer the question, do NOT pick one yourself and never spawn a Session to sidestep the choice — report the candidates and let the user decide. The `ambiguous` and `nextStep` fields state this for each result; send only when the routing is clear.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: {
          type: 'string',
          description: 'What you need answered, in the words you would use to ask it. Topic terms (module names, table names, error text, endpoint paths) search best.',
        },
        limit: { type: 'integer', description: 'Maximum candidates to return. Defaults to the configured find limit (5).' },
      },
      required: ['question'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'The question as searched.' },
          indexed: {
            type: 'boolean',
            description: 'True when the Host full-text index answered the query; false when only title/directory metadata was available.',
          },
          searched: { type: 'integer', description: 'Number of Sessions considered.' },
          returned: { type: 'integer', description: 'Candidates in this result.' },
          ambiguous: {
            type: 'boolean',
            description: 'True when the routing is NOT clear: several equally plausible Sessions, a metadata-only guess, or no match. Then put the choice to the user instead of picking one yourself.',
          },
          nextStep: {
            type: 'string',
            description: 'What to do with this result, including when to stop and ask the user instead of choosing a Session or spawning one.',
          },
          candidates: {
            type: 'array',
            description: 'Best Sessions to ask, strongest match first.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                title: { type: 'string' },
                cwd: { type: 'string' },
                busy: { type: 'boolean', description: 'True when the Session is running a turn right now.' },
                live: { type: 'boolean', description: 'True when the Session is live in this Host rather than only on disk.' },
                sameWorkspace: { type: 'boolean', description: 'True when this Session works in your own working directory, so writes can collide.' },
                hasThread: { type: 'boolean', description: 'True when you already share a bus conversation with it; pass that thread id when you answer.' },
                snippet: { type: 'string', description: 'The matching lines from its transcript, flattened and bounded.' },
                matchedAt: { type: 'string', description: 'When the matching text was written.' },
                matchedType: { type: 'string', description: 'Session event type the match came from, for example `user/message`.' },
                why: { type: 'string', description: 'One-line reason this Session is a candidate.' },
              },
              required: ['sessionId', 'busy', 'live', 'sameWorkspace', 'hasThread', 'why'],
            },
          },
          note: { type: 'string', description: 'How to use the result: read-only, confirm then send.' },
        },
        required: ['query', 'indexed', 'searched', 'returned', 'candidates', 'ambiguous', 'nextStep', 'note'],
      },
      render: (_args, value) => [{ type: 'text', text: renderFind(value) }],
    },
    async execute(args, exec) {
      return bus.find({
        question: args.question,
        limit: args.limit,
        sender: senderOf(exec),
        signal: deadline(exec),
      });
    },
  }));
}

/**
 * Tool bodies return the service value as-is.
 *
 * `defineTool` projects every result onto the tool's declared `output.schema`
 * before the registry sees it, so there is no hand-maintained key list here
 * that could drift away from the schema — the failure mode that once made
 * `bus_send` and `bus_read` report an error after their side effect had already
 * happened.
 */

/** Render the `bus_list` result as a compact table the model can read directly. */
function renderList(value) {
  const lines = [`Sessions: ${value.total} matching, ${value.sessions.length} shown${value.hasMore === true ? ` (next offset ${(value.offset ?? 0) + value.sessions.length})` : ''}.`];
  for (const row of value.sessions) {
    const state = row.running ? 'running' : 'idle';
    const marks = [
      row.isSelf ? 'this Session' : undefined,
      row.isSubagent ? 'subagent (not targetable)' : 'targetable',
      row.sameCwdAsCaller ? 'shares your working directory — agree on write scopes' : undefined,
    ].filter((mark) => mark !== undefined);
    lines.push(
      `- ${row.sessionId} "${row.title ?? '(untitled)'}" [${state}; ${marks.join('; ')}] @ ${row.cwd ?? '(unknown)'} (last activity ${row.updatedAtIso})`,
    );
  }
  if (value.sessions.length === 0) lines.push('No Session matched. Try a different query or bus_spawn to create one.');
  else lines.push('Push work with bus_send({ to: "<sessionId>", message: "..." }).');
  return lines.join('\n');
}

/** Render the `bus_threads` result: what is still owed, and by whom. */
function renderThreads(value) {
  if (value.threads.length === 0) return 'No bus conversations yet in this Session.';
  const lines = [`Bus conversations: ${value.total}${value.threads.length < value.total ? `, ${value.threads.length} shown` : ''}.`];
  for (const thread of value.threads) {
    const state = thread.awaitingYou
      ? 'WAITING FOR YOU to answer'
      : thread.pending
        ? 'pending: waiting for the peer to answer'
        : 'closed';
    lines.push(
      `- ${thread.threadId} peer=${thread.peer ?? '(unknown)'} hop=${thread.hop}/${thread.hopBudget} (${thread.hopRemaining} left) last=${thread.lastMessageId} at ${thread.lastAt} — ${state}`,
    );
  }
  lines.push('Answer with bus_send({ to: "<peer>", message: "...", thread: "<threadId>" }).');
  return lines.join('\n');
}

/** Render the `bus_find` result: which Sessions to ask, and why. */
function renderFind(value) {
  const source = value.indexed ? 'conversation content' : 'title and directory metadata only';
  const lines = [`Candidates for "${value.query}": ${value.returned} of ${value.searched} Session(s), searched ${source}.`];
  for (const candidate of value.candidates) {
    const marks = [
      candidate.busy ? 'running a turn' : 'idle',
      candidate.sameWorkspace ? 'shares your working directory' : undefined,
      candidate.hasThread ? 'you already share a thread' : undefined,
    ].filter((mark) => mark !== undefined);
    lines.push(
      `- ${candidate.sessionId} "${candidate.title ?? '(untitled)'}" @ ${candidate.cwd ?? '(unknown)'} [${marks.join('; ')}] — ${candidate.why}`,
    );
    if (candidate.snippet !== undefined) lines.push(`  "${candidate.snippet}"`);
  }
  if (value.candidates.length === 0) lines.push('Nothing matched. Try different topic terms, or bus_list to scan titles.');
  lines.push(value.nextStep);
  lines.push(value.note);
  return lines.join('\n');
}

/** Render the `bus_read` result as a small transcript. */
function renderTranscript(value) {
  const header = `${value.sessionId}${value.title === undefined ? '' : ` "${value.title}"`}${value.cwd === undefined ? '' : ` @ ${value.cwd}`} [${value.running ? 'running' : 'idle'}]`;
  const lines = [header, `Last ${value.returned} message(s) of ${value.totalEvents} event(s)${value.truncated ? ' (truncated)' : ''}.`];
  for (const message of value.messages) {
    lines.push(`--- ${message.role}${message.viaBus ? ' (session-bus message)' : ''} ${message.at}`);
    lines.push(message.text);
  }
  if (value.messages.length === 0) lines.push('(no user or assistant messages yet)');
  return lines.join('\n');
}

/** Read the title and agent preset of a live Session from its log. */
function scanSessionIdentity(session) {
  try {
    const events = session?.snapshotEvents?.();
    if (!Array.isArray(events)) return { title: undefined, preset: undefined };
    let title;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type === 'session/title' && typeof event.data?.title === 'string') {
        title = event.data.title;
        break;
      }
    }
    const preset = typeof session?.header?.agentPreset === 'string' ? session.header.agentPreset : undefined;
    return { title, preset };
  } catch {
    return { title: undefined, preset: undefined };
  }
}

/** Combine a caller signal with a delivery deadline. */
function withDeadline(signal, timeoutMs) {
  if (signal === undefined) return AbortSignal.timeout(timeoutMs);
  if (typeof AbortSignal.any !== 'function') return signal;
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}
