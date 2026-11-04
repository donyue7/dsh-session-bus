/**
 * Model-facing tools of the session bus.
 *
 * Messaging tools:
 *   - `bus_list`    discover Sessions that can be reached
 *   - `bus_send`    push a message into one, waking it
 *   - `bus_read`    read the recent transcript of one (collect an answer)
 *   - `bus_spawn`   create a new Session in a workspace and push its first message
 *   - `bus_threads` list the conversations this Session is part of
 *   - `bus_find`    find the Session whose transcript answers a question
 *
 * Coordination tools (a workspace with one main Session and several module owners):
 *   - `bus_roles`     register or inspect `main`/`dev` roles
 *   - `bus_task`      create, claim, update, and list work items
 *   - `bus_attention` ask one concrete question and record the human answer
 *
 * Write-lease tools:
 *   - `bus_lease`   claim paths before editing them
 *   - `bus_release` release a claim
 *   - `bus_leases`  list active claims
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
      'Push a message into another DSH Session and wake it. The target Session is resumed automatically if it is cold, and the message wakes it exactly like typed input: an idle Session starts a new turn, a busy Session receives it when its current turn ends (mode "queue"), immediately and unconditionally (mode "steer"), or immediately only while it is actually running (mode "interrupt"). Use "interrupt" for conclusions, corrections, or answers the peer is waiting for: the peer then sees them inside its running turn instead of finishing work on the old assumption. The bus already upgrades a reply to the peer\'s own message to interrupt while that peer is running, so name "queue" only to opt out of that. By default the message is recorded with the DSH `agent-message` source, so the receiving Web UI shows it as a non-human "task message received" card rather than a right-aligned bubble that looks like the local user typed it. Use this instead of asking the user to stop a Session and paste text into it. The receiving Session does not share your conversation, so write a self-contained message, and expect the answer as a new bus message or read it with bus_read. Mark the message with a kind when it is not a conclusion: a task, notice, or acknowledgement must not interrupt a running turn. A genuinely long collaboration can raise the thread budget with max_hops instead of using force on every send; finish a conversation with closing: true so the peer knows no answer is expected; start an unrelated send with new_thread: true; use mode "inbox" for notes that must not wake the peer.',
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
          enum: ['queue', 'steer', 'interrupt', 'inbox'],
          description: 'Delivery mode. "queue" (default) waits behind a running turn; "steer" injects into the running turn immediately; "interrupt" is the conclusion-safe mode — inject into a running turn, normal wake when the Session is idle or cold; "inbox" leaves the message in the target inbox without waking it (it costs the peer no extra turn). A reply to the peer’s own message and any "correction" are upgraded to interrupt automatically while the peer runs (config interruptReplies); pass "queue" to opt out, "steer" to force immediate injection regardless of state.',
        },
        kind: {
          type: 'string',
          enum: ['task', 'conclusion', 'correction', 'question', 'notice', 'ack'],
          description: 'What this message is. "conclusion" and "correction" are upgraded to interrupt (the former when answering the peer’s own message, the latter whenever the peer is running, so a correction reaches it mid-turn instead of after the wrong work is finished); "task", "notice", and "ack" stay queued so a routine acknowledgement never interrupts a running turn.',
        },
        max_hops: {
          type: 'integer',
          description: 'Raise this conversation’s hop budget to at least this number (1-64) for the rest of the thread. Use it for a deliberately long exchange instead of passing force on every send.',
        },
        new_thread: {
          type: 'boolean',
          description: 'Start a new conversation instead of continuing the thread the bus would pick automatically.',
        },
        closing: {
          type: 'boolean',
          description: 'Close the conversation: the peer is told not to answer, the message is exempt from the hop budget, and the thread stops counting as pending.',
        },
        payload: {
          type: 'object',
          additionalProperties: true,
          description: 'Machine-readable structured result (a JSON object, at most 8000 characters serialized). Use it for facts the receiver should parse — ids, commit hashes, amounts, field tables — instead of writing them in prose. Rendered as a --- payload --- section.',
        },
        attachments: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', description: 'File the receiver should read: absolute, or relative to your working directory.' },
              note: { type: 'string', description: 'One line saying what this file is.' },
              sha256: { type: 'string', description: 'Optional SHA-256 of the file content (64 hex characters), so the receiver can verify it read the intended bytes.' },
            },
            required: ['path'],
          },
          description: 'Files the receiver should read by path instead of receiving their content inline. At most 16.',
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
          kind: { type: 'string', description: 'Message kind, when one was given.' },
          closing: { type: 'boolean', description: 'True when this delivery closed the thread.' },
          injected: { type: 'string', description: 'How the target took the message: followup, steer, inbox, prompt mode, or duplicate.' },
          duplicate: { type: 'boolean', description: 'True when the bus recognised this exact message as already delivered.' },
          messageId: { type: 'string' },
          threadId: { type: 'string', description: 'Conversation id; pass it back when answering so the sender can match the reply.' },
          replyTo: { type: 'string', description: 'Message id this delivery answers, when it continued a thread.' },
          hop: { type: 'integer' },
          hopBudget: { type: 'integer' },
          hopRemaining: { type: 'integer', description: 'Hop budget left in this conversation.' },
          targetRunning: { type: 'boolean' },
          interrupted: { type: 'boolean', description: 'True when the message was injected into a running turn instead of queued behind it.' },
          crossWorkspace: { type: 'boolean' },
          permission: { type: 'string', description: 'Permission preset now in force for the target Session.' },
          spooled: { type: 'boolean', description: 'True when the body was too long and was written to a spool file instead.' },
          payload: { type: 'boolean', description: 'True when a structured payload was attached.' },
          attachments: { type: 'integer', description: 'Number of file attachments named in this message.' },
          note: { type: 'string' },
        },
        required: ['delivered', 'sessionId', 'mode', 'messageId', 'hop', 'hopBudget', 'targetRunning', 'crossWorkspace', 'note'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Delivered to ${value.sessionId}${value.title === undefined ? '' : ` "${value.title}"`}${value.cwd === undefined ? '' : ` @ ${value.cwd}`}.`,
          `mode=${value.mode}${value.kind === null || value.kind === undefined ? '' : ` kind=${value.kind}`}${value.closing === true ? ' closing' : ''}${value.interrupted === true ? ' interrupted' : ''}${value.injected === undefined ? '' : ` injected=${value.injected}`} thread=${value.threadId} hop=${value.hop}/${value.hopBudget} (${value.hopRemaining ?? 0} left) msg=${value.messageId}${value.replyTo === undefined ? '' : ` re=${value.replyTo}`}${value.crossWorkspace ? ' cross-workspace' : ''}${value.permission === undefined ? '' : ` permission=${value.permission}`}${value.spooled === true ? ' body-spooled' : ''}${value.payload === true ? ' payload' : ''}${value.attachments > 0 ? ` attachments=${value.attachments}` : ''}`,
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
        kind: args.kind,
        maxHops: args.max_hops,
        newThread: args.new_thread === true,
        closing: args.closing === true,
        force: args.force === true,
        threadId: args.thread,
        replyTo: args.reply_to,
        writeScopes: args.write_scopes,
        payload: args.payload,
        attachments: args.attachments,
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
      'Create a new DSH Session in a workspace and push its first message, so a fresh Session starts working in another working directory without the user opening it. The new Session runs the same agent preset as the caller unless `preset` is given. With `role`, it is also registered in the workspace (one `main` coordinator, any number of `dev` module owners) so later messages reach it with { to: "main" } or by role. In the default notice presentation its title is taken from the first line of the message. Use it when the task belongs in a workspace that has no suitable Session yet, or when a module needs its own long-lived Session; prefer bus_send when an existing Session already fits.',
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
        preset: {
          type: 'string',
          description: 'Agent preset for the new Session (for example "main-session" or "dev-session"). Defaults to the calling Session preset.',
        },
        role: {
          type: 'string',
          enum: ['main', 'dev'],
          description: 'Register the new Session under this role. A workspace has one main Session; spawning a second main one is refused unless force is true.',
        },
        module: {
          type: 'string',
          description: 'Module or feature the new dev Session owns (for example "Gys_Frontend").',
        },
        force: {
          type: 'boolean',
          description: 'Replace the workspace main Session when role is "main".',
        },
        mode: {
          type: 'string',
          enum: ['queue', 'steer', 'interrupt'],
          description: 'Delivery mode for the first message. "queue" is the default and is correct for a brand-new Session; "steer"/"interrupt" matter only when a retried spawn adopts a Session that is already running.',
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
          role: { type: 'string', description: 'Role registered for the new Session, when one was requested.' },
          module: { type: 'string', description: 'Module the new dev Session owns.' },
          workspace: { type: 'string', description: 'Workspace root the registered role belongs to.' },
          note: { type: 'string' },
        },
        required: ['delivered', 'sessionId', 'mode', 'messageId', 'hop', 'hopBudget', 'created', 'note'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Created ${value.sessionId}${value.cwd === undefined ? '' : ` @ ${value.cwd}`} and delivered the first message.`,
          `mode=${value.mode} hop=${value.hop}/${value.hopBudget} msg=${value.messageId}${value.permission === undefined ? '' : ` permission=${value.permission}`}${value.role === undefined ? '' : ` role=${value.role}${value.module === undefined ? '' : ` module=${value.module}`}`}`,
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
        preset: args.preset ?? sender.preset,
        role: args.role,
        module: args.module,
        force: args.force === true,
        sender,
        signal: deadline(exec),
      });
      return receipt;
    },
  }));

  const roleEntrySchema = {
    sessionId: { type: 'string' },
    role: { type: 'string' },
    module: { type: 'string' },
    workspace: { type: 'string' },
    cwd: { type: 'string' },
    title: { type: 'string' },
    registeredAt: { type: 'string' },
    updatedAt: { type: 'string' },
    running: { type: 'boolean' },
    targetable: { type: 'boolean' },
    mine: { type: 'boolean' },
  };

  ctx.tools.register(defineTool({
    name: 'bus_roles',
    description:
      'Register or inspect the roles that make a workspace addressable. A workspace has one main Session (the Session the user talks to) and any number of dev Sessions that own modules. Once registered, any Session can reach the coordinator with bus_send({ to: "main" }) instead of naming a raw sessionId, and bus_list shows each Session role. Register the main Session once (it can register itself), and register dev Sessions with bus_spawn role=dev or action=register. Use action=list to see who is who and whether they are running.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'register', 'clear'],
          description: 'What to do. "list" shows every registered role; "register" assigns one; "clear" forgets one.',
        },
        role: { type: 'string', enum: ['main', 'dev'], description: 'Role to register.' },
        session_id: { type: 'string', description: 'Session to register; defaults to the calling Session.' },
        module: { type: 'string', description: 'Module a dev Session owns (for example "Gys_Frontend").' },
        workspace: { type: 'string', description: 'Workspace root to attach the role to; defaults to the registered workspace of the Session directory.' },
        cwd: { type: 'string', description: 'Session working directory, when it must be stated explicitly.' },
        title: { type: 'string', description: 'Display title override.' },
        force: { type: 'boolean', description: 'Replace the workspace existing main Session when registering main.' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer' },
          roles: { type: 'array', items: { type: 'object', additionalProperties: false, properties: roleEntrySchema } },
          registered: { type: 'object', additionalProperties: false, properties: roleEntrySchema },
          cleared: { type: 'boolean' },
          sessionId: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['note'],
      },
      render: (_args, value) => [{ type: 'text', text: renderRoles(value) }],
    },
    async execute(args, exec) {
      const sender = senderOf(exec);
      const signal = deadline(exec);
      if (args.action === 'list') {
        return bus.roles({ sender, role: args.role, module: args.module, workspace: args.workspace, signal });
      }
      if (args.action === 'clear') {
        return bus.role({ sessionId: args.session_id, sender, clear: true, signal });
      }
      return bus.role({
        sessionId: args.session_id,
        role: args.role,
        module: args.module,
        workspace: args.workspace,
        cwd: args.cwd,
        title: args.title,
        force: args.force === true,
        sender,
        signal,
      });
    },
  }));

  const taskEntrySchema = {
    taskId: { type: 'string' },
    title: { type: 'string' },
    module: { type: 'string' },
    status: { type: 'string' },
    owner: { type: 'string' },
    assignee: { type: 'string' },
    cwd: { type: 'string' },
    workspace: { type: 'string' },
    notes: { type: 'array' },
    evidence: { type: 'array' },
    attentionIds: { type: 'array' },
    openAttentions: { type: 'integer' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    closedAt: { type: 'string' },
  };

  ctx.tools.register(defineTool({
    name: 'bus_task',
    description:
      'Keep a workspace ledger of who is doing what: create a task, claim it, report progress, and list open work. The main Session opens tasks with action=create; a dev Session claims its task with action=claim (which moves it to in_progress), and reports with action=update. A ready report needs evidence (a commit, a test command and its result, a URL); "the change exists" is not the same as "the work is finished". Use action=list with mine=true to see your own tasks instead of reading transcripts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'get', 'claim', 'update'],
          description: 'Operation to perform.',
        },
        task_id: { type: 'string', description: 'Task to get, claim, or update.' },
        title: { type: 'string', description: 'What should be done, for create. Keep acceptance criteria in the title or a note.' },
        module: { type: 'string', description: 'Module or feature the task belongs to.' },
        assignee: { type: 'string', description: 'Session expected to do the work, when known at creation.' },
        note: { type: 'string', description: 'Note to append to the task.' },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'Proof of work for a ready report: commands, results, commit hashes, URLs.',
        },
        status: {
          type: 'string',
          enum: ['open', 'in_progress', 'blocked', 'ready', 'done', 'dropped', 'active', 'closed', 'all'],
          description: 'Next status for update, or a filter for list (active/closed/all are list filters).',
        },
        mine: { type: 'boolean', description: 'List only tasks owned by or assigned to the caller.' },
        limit: { type: 'integer', description: 'Maximum rows for list. Defaults to 30.' },
        workspace: { type: 'string', description: 'Workspace root, for create or filtering.' },
        cwd: { type: 'string', description: 'Working directory where the work happens.' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task: { type: 'object', additionalProperties: false, properties: taskEntrySchema },
          tasks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: taskEntrySchema } },
          total: { type: 'integer' },
          note: { type: 'string' },
        },
        required: ['note'],
      },
      render: (_args, value) => [{ type: 'text', text: renderTask(value) }],
    },
    async execute(args, exec) {
      const sender = senderOf(exec);
      return bus.task({
        action: args.action,
        taskId: args.task_id,
        title: args.title,
        module: args.module,
        assignee: args.assignee,
        note: args.note,
        evidence: args.evidence,
        status: args.status,
        mine: args.mine === true,
        limit: args.limit,
        workspace: args.workspace,
        cwd: args.cwd,
        sender,
        signal: deadline(exec),
      });
    },
  }));

  const attentionEntrySchema = {
    attentionId: { type: 'string' },
    taskId: { type: 'string' },
    question: { type: 'string' },
    options: { type: 'array' },
    recommendation: { type: 'string' },
    status: { type: 'string' },
    askedBy: { type: 'string' },
    answer: { type: 'string' },
    answeredBy: { type: 'string' },
    reason: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  };

  ctx.tools.register(defineTool({
    name: 'bus_attention',
    description:
      'Ask one concrete question that needs a human decision, and record the answer. Use it instead of stalling behind a free-text transcript: name the blocked task, write exactly one question, and give bounded options plus a recommendation so the user can answer by picking. Asking forwards the question to the main Session, which relays it to the user unchanged; when the user answers, the main Session records it with action=answer and the blocked task becomes in_progress again. Never put several concerns in one attention, and never treat progress as a question.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['ask', 'list', 'answer', 'cancel'],
          description: 'Operation to perform.',
        },
        task_id: { type: 'string', description: 'Task the question blocks, for ask.' },
        question: { type: 'string', description: 'The one question to ask, in the words the user should answer.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Bounded choices, at most 8. Keep each option short.',
        },
        recommendation: { type: 'string', description: 'The answer you recommend, and why.' },
        attention_id: { type: 'string', description: 'Question to answer or cancel.' },
        answer: { type: 'string', description: 'The decision the user gave, quoted as they gave it.' },
        reason: { type: 'string', description: 'Why a question is no longer needed, for cancel.' },
        status: { type: 'string', enum: ['open', 'answered', 'cancelled', 'all'], description: 'Filter for list; open is the default.' },
        limit: { type: 'integer', description: 'Maximum rows for list. Defaults to 30.' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attention: { type: 'object', additionalProperties: false, properties: attentionEntrySchema },
          attentions: { type: 'array', items: { type: 'object', additionalProperties: false, properties: attentionEntrySchema } },
          total: { type: 'integer' },
          delivered: { type: 'boolean' },
          deliveryError: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['note'],
      },
      render: (_args, value) => [{ type: 'text', text: renderAttention(value) }],
    },
    async execute(args, exec) {
      const sender = senderOf(exec);
      return bus.attention({
        action: args.action,
        taskId: args.task_id,
        question: args.question,
        options: args.options,
        recommendation: args.recommendation,
        attentionId: args.attention_id,
        answer: args.answer,
        reason: args.reason,
        status: args.status,
        limit: args.limit,
        sender,
        signal: deadline(exec),
      });
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
                lastAgeMinutes: { type: 'integer' },
                lastKind: { type: 'string' },
                lastPreview: { type: 'string' },
                lastMessageState: { type: 'string', enum: ['queued', 'consumed', 'unknown'] },
                peerRunning: { type: 'boolean' },
                closed: { type: 'boolean' },
                state: { type: 'string', enum: ['awaitingYou', 'pending', 'idle', 'closed'] },
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
      return await bus.threads({ sender: senderOf(exec), limit: args.limit });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'bus_lease',
    description:
      'Claim paths before editing them when another Session shares your working directory, so two agents do not overwrite each other. A lease names the files or directories you are about to write, is visible to the peer with bus_leases, and expires on its own (default 30 minutes) — release it with bus_release when you finish. If the claim is refused, do not force it: the conflict lists who holds the paths; send the peer a bus_send to agree on who writes what, wait for its release, or use force only when the user has decided you should take over. A lease is an advisory claim, not a filesystem lock: write_scopes on a message is a declaration, a lease is an active claim.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files or directories you intend to write: absolute, or relative to your working directory. A directory claims everything below it. At most 20.',
        },
        note: { type: 'string', description: 'One line saying what you are changing, so the peer can decide whether to wait.' },
        ttl_minutes: { type: 'integer', description: 'How long the claim stays valid, in minutes (1-480). Defaults to the configured lease TTL (30).' },
        force: { type: 'boolean', description: 'Take the paths even when another Session holds an overlapping lease. Only after the user or the peer explicitly agreed.' },
      },
      required: ['paths'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          granted: { type: 'boolean' },
          sessionId: { type: 'string' },
          workspace: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
          ttlMinutes: { type: 'integer' },
          leaseId: { type: 'string', description: 'Lease id to pass to bus_release.' },
          note: { type: 'string' },
          expiresAt: { type: 'string' },
          expiresInMinutes: { type: 'integer' },
          conflicts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                leaseId: { type: 'string' },
                sessionId: { type: 'string' },
                workspace: { type: 'string' },
                paths: { type: 'array', items: { type: 'string' } },
                note: { type: 'string' },
                expiresAt: { type: 'string' },
                expiresInMinutes: { type: 'integer' },
              },
            },
          },
        },
        required: ['granted', 'sessionId', 'workspace', 'note'],
      },
      render: (_args, value) => [{ type: 'text', text: renderLease(value) }],
    },
    async execute(args, exec) {
      return bus.lease({
        sender: senderOf(exec),
        paths: args.paths,
        note: args.note,
        ttlMinutes: args.ttl_minutes,
        force: args.force === true,
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'bus_release',
    description:
      'Release a write lease you hold, so the Session sharing your working directory can edit those paths. Omit lease to release every lease you hold. Leases also expire on their own, so a forgotten release does not block the peer forever.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lease: { type: 'string', description: 'Lease id from bus_lease or bus_leases. Omit to release all your leases.' },
        all: { type: 'boolean', description: 'Release every lease this Session holds.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          released: { type: 'array', items: { type: 'string' } },
          missing: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['sessionId', 'released', 'missing', 'note'],
      },
      render: (_args, value) => [{ type: 'text', text: renderRelease(value) }],
    },
    async execute(args, exec) {
      return bus.release({ sender: senderOf(exec), leaseId: args.lease, all: args.all === true });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'bus_leases',
    description:
      'List the write leases in this workspace: who claimed which paths, for how long, and whether the claim is still valid. Check it before editing shared files, or when the user asks who is working on which files. Read-only — it never wakes a Session.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include_expired: { type: 'boolean', description: 'Also list leases that have already expired (kept for 24 hours).' },
        workspace: { type: 'string', description: 'Only list leases whose workspace path contains this text.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer' },
          leases: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                leaseId: { type: 'string' },
                sessionId: { type: 'string' },
                title: { type: 'string' },
                workspace: { type: 'string' },
                paths: { type: 'array', items: { type: 'string' } },
                note: { type: 'string' },
                ageMinutes: { type: 'integer' },
                expiresInMinutes: { type: 'integer' },
                expired: { type: 'boolean' },
                mine: { type: 'boolean' },
              },
            },
          },
          note: { type: 'string' },
        },
        required: ['total', 'leases', 'note'],
      },
      render: (_args, value) => [{ type: 'text', text: renderLeases(value) }],
    },
    async execute(args, exec) {
      return bus.leases({
        sender: senderOf(exec),
        includeExpired: args.include_expired === true,
        workspace: args.workspace,
      });
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
    const state = thread.state === 'closed' || thread.closed === true
      ? 'closed: no answer expected'
      : thread.state === 'awaitingYou' || thread.awaitingYou
        ? 'WAITING FOR YOU to answer'
        : thread.state === 'pending' || thread.pending
          ? 'pending: waiting for the peer to answer'
          : 'idle';
    const delivery = thread.lastMessageState === undefined
      ? ''
      : ` [${thread.peerRunning === true ? 'peer running' : thread.peerRunning === false ? 'peer idle' : 'peer state unknown'}; last message ${thread.lastMessageState}]`;
    const preview = thread.lastPreview === undefined ? '' : ` "${thread.lastPreview}"`;
    const kind = thread.lastKind === undefined ? '' : ` kind=${thread.lastKind}`;
    lines.push(
      `- ${thread.threadId} peer=${thread.peer ?? '(unknown)'} hop=${thread.hop}/${thread.hopBudget} (${thread.hopRemaining} left) last=${thread.lastMessageId} at ${thread.lastAt}${delivery}${preview}${kind} — ${state}`,
    );
  }
  lines.push('Answer with bus_send({ to: "<peer>", message: "...", thread: "<threadId>" }).');
  return lines.join('\n');
}

/** Render the `bus_lease` result: what was claimed, or who stands in the way. */
function renderLease(value) {
  const lines = [];
  if (value.granted) {
    lines.push(`Lease granted: ${value.leaseId} on ${value.paths.length} path(s) for ${value.ttlMinutes} minute(s), expires at ${value.expiresAt} (${value.expiresInMinutes} min left).`);
  } else {
    lines.push(`Lease refused: ${value.conflicts.length} conflicting claim(s) on these paths.`);
    for (const conflict of value.conflicts) {
      lines.push(`- ${conflict.leaseId} held by ${conflict.sessionId}${conflict.note === undefined ? '' : ` "${conflict.note}"`} on ${conflict.paths.join(', ')} (expires in ${conflict.expiresInMinutes} min)`);
    }
  }
  lines.push(value.note);
  return lines.join('\n');
}

/** Render the `bus_release` result. */
function renderRelease(value) {
  const lines = [
    value.released.length === 0
      ? 'No lease released.'
      : `Released ${value.released.length} lease(s): ${value.released.join(', ')}.`,
  ];
  if (value.missing.length > 0) lines.push(`Not held by this Session: ${value.missing.join(', ')}.`);
  lines.push(value.note);
  return lines.join('\n');
}

/** Render the `bus_leases` result as a table of claims. */
function renderLeases(value) {
  if (value.leases.length === 0) return `No write leases. ${value.note}`;
  const lines = [`Write leases: ${value.leases.length} of ${value.total}.`];
  for (const lease of value.leases) {
    const age = lease.expired ? 'expired' : `${lease.expiresInMinutes} min left`;
    lines.push(`- ${lease.leaseId}${lease.mine ? ' (yours)' : ''} ${lease.sessionId}${lease.title === undefined ? '' : ` "${lease.title}"`} @ ${lease.workspace} on ${lease.paths.join(', ')}${lease.note === undefined ? '' : ` — ${lease.note}`} [${age}]`);
  }
  lines.push(value.note);
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

/** Render a role registration result or the role table. */
function renderRoles(value) {
  const lines = [];
  if (value.registered !== undefined) {
    const record = value.registered;
    lines.push(
      `${record.sessionId} is registered as ${record.role}`
      + `${record.module === undefined ? '' : ` for ${record.module}`}`
      + `${record.workspace === undefined ? '' : ` in ${record.workspace}`}.`,
    );
  } else if (value.cleared !== undefined) {
    lines.push(value.cleared === true ? `${value.sessionId} is no longer registered.` : `${value.sessionId} had no role to clear.`);
  }
  if (Array.isArray(value.roles) && value.roles.length > 0) {
    lines.push(`roles (${value.total}):`);
    for (const record of value.roles) {
      const marks = [
        record.running === true ? 'running' : 'idle',
        record.mine === true ? 'you' : undefined,
        record.targetable === false ? 'not targetable' : undefined,
      ].filter((mark) => mark !== undefined);
      lines.push(
        `- ${record.role} ${record.sessionId}`
        + `${record.module === undefined ? '' : ` [${record.module}]`}`
        + `${record.title === undefined ? '' : ` "${record.title}"`} (${marks.join('; ')})`,
      );
    }
  }
  if (value.note !== undefined) lines.push(value.note);
  return lines.join('\n');
}

/** Render one task, or the task table. */
function renderTask(value) {
  const lines = [];
  if (value.task !== undefined) {
    const task = value.task;
    const meta = [
      task.module === undefined ? undefined : `module=${task.module}`,
      task.assignee === undefined ? undefined : `assignee=${task.assignee}`,
      task.owner === undefined ? undefined : `owner=${task.owner}`,
      task.openAttentions === undefined ? undefined : `openAttentions=${task.openAttentions}`,
    ].filter((mark) => mark !== undefined);
    lines.push(`${task.taskId} [${task.status}] ${task.title}`);
    if (meta.length > 0) lines.push(meta.join(' '));
    if (Array.isArray(task.evidence) && task.evidence.length > 0) lines.push(`evidence: ${task.evidence.join(' | ')}`);
  }
  if (Array.isArray(value.tasks) && value.tasks.length > 0) {
    lines.push(`tasks (${value.total}):`);
    for (const task of value.tasks) {
      const suffix = [
        task.assignee === undefined ? undefined : `→ ${task.assignee}`,
        task.openAttentions !== undefined && task.openAttentions > 0 ? `${task.openAttentions} open question(s)` : undefined,
      ].filter((mark) => mark !== undefined);
      lines.push(`- ${task.taskId} [${task.status}] ${task.title}${suffix.length === 0 ? '' : ` ${suffix.join(' · ')}`}`);
    }
  }
  if (value.note !== undefined) lines.push(value.note);
  return lines.join('\n');
}

/** Render one attention, or the open-question table. */
function renderAttention(value) {
  const lines = [];
  if (value.attention !== undefined) {
    const attention = value.attention;
    lines.push(`${attention.attentionId} [${attention.status}] ${attention.taskId}`);
    lines.push(`question: ${attention.question}`);
    if (Array.isArray(attention.options) && attention.options.length > 0) {
      lines.push('options:');
      for (const option of attention.options) lines.push(`- ${option}`);
    }
    if (attention.recommendation !== undefined) lines.push(`recommendation: ${attention.recommendation}`);
    if (attention.answer !== undefined) lines.push(`answer: ${attention.answer}`);
    if (attention.reason !== undefined) lines.push(`reason: ${attention.reason}`);
  }
  if (Array.isArray(value.attentions) && value.attentions.length > 0) {
    lines.push(`questions (${value.total}):`);
    for (const attention of value.attentions) {
      lines.push(`- ${attention.attentionId} [${attention.status}] ${attention.question}`);
    }
  }
  if (value.delivered === true) lines.push('Forwarded to the main Session.');
  else if (value.delivered === false) lines.push('Not forwarded to the main Session; relay it yourself.');
  if (value.deliveryError !== undefined) lines.push(`delivery failed: ${value.deliveryError}`);
  if (value.note !== undefined) lines.push(value.note);
  return lines.join('\n');
}

/** Render the `bus_read` result as a small transcript. */
function renderTranscript(value) {
  const header = `${value.sessionId}${value.title === undefined ? '' : ` "${value.title}"`}${value.cwd === undefined ? '' : ` @ ${value.cwd}`} [${value.running ? 'running' : 'idle'}]`;
  const lines = [header, `Last ${value.returned} message(s) of ${value.totalEvents} event(s)${value.truncated ? ' (truncated)' : ''}.`];
  for (const message of value.messages) {
    lines.push(`--- ${message.role}${message.viaBus ? ' (session-bus message)' : ''} ${message.at}${messageAge(message.at)}`);
    lines.push(message.text);
  }
  if (value.messages.length === 0) lines.push('(no user or assistant messages yet)');
  return lines.join('\n');
}

/** A compact age suffix for a message timestamp, or an empty string. */
function messageAge(at) {
  const written = Date.parse(at);
  if (!Number.isFinite(written)) return '';
  const minutes = Math.round((Date.now() - written) / 60000);
  return minutes >= 30 ? ` (${minutes} min old)` : '';
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
