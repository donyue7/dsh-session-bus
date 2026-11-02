/**
 * The system-prompt section that tells every agent the session bus exists and
 * how to behave on both sides of it.
 *
 * @module dsh-session-bus/prompt
 */

/** Section name used for scoped replacement and diagnostics. */
export const PROMPT_SECTION_NAME = 'tool:session-bus';

/**
 * Placement between the subagent tooling block (2800) and the report block
 * (2900): the bus is a delegation surface, so it belongs beside them.
 */
export const PROMPT_SECTION_ORDER = 2850;

/** The section text contributed to every assembled system prompt. */
export const PROMPT_SECTION = `## Inter-Session messaging (session bus)

Other DSH Sessions — in this workspace or in other working directories — are reachable from this one. Use the bus instead of asking the user to pause a Session and copy text between conversations.

- \`bus_list\` — list reachable Sessions with their exact sessionId, title, working directory, and busy state.
- \`bus_find({ question })\` — find the Sessions whose conversations actually discuss a topic, across every workspace. It searches Session text (not just titles) and returns a short ranked list with the matching snippets. Use it before asking anything non-trivial.
- \`bus_send({ to, message, mode })\` — push a message into a Session. A cold or idle Session is resumed and starts a new turn; a busy Session receives the message when its current turn ends (\`mode: "queue"\`), immediately and unconditionally (\`mode: "steer"\`), or immediately only while it is running (\`mode: "interrupt"\`). The bus already upgrades a reply to the peer's own message to interrupt while that peer runs, so \`queue\` is the explicit opt-out. Name \`kind\` (\`task\`/\`conclusion\`/\`correction\`/\`question\`/\`notice\`/\`ack\`) so only a conclusion or correction is allowed to interrupt; use \`mode: "inbox"\` for a note that must not wake the peer; raise a thread budget with \`max_hops\`; end a conversation with \`closing: true\`; start an unrelated one with \`new_thread: true\`.
- \`bus_read({ session })\` — read the tail of another Session transcript to collect its answer. Reading never wakes it.
- \`bus_spawn({ message, workspace })\` — create a new Session in a workspace and start it with that message (in the default notice presentation the new Session is named from the first line of \`message\`). Pass \`preset\` to pick the agent preset (the workspace main Session uses \`main-session\`) and \`role: "main" | "dev"\` to register the new Session's role in one step.
- \`bus_roles({ action })\` — register or inspect who is who in a workspace: \`main\` is the one Session the user talks to, \`dev\` Sessions own modules. Once a main is registered, any Session can address it with \`bus_send({ to: "main" })\` instead of naming a raw sessionId.
- \`bus_task({ action })\` — the workspace ledger of who does what: the main Session creates tasks (\`create\`), a dev Session claims its task (\`claim\`, which moves it to \`in_progress\`) and reports with \`update\` (\`ready\` needs \`evidence\`). Use \`list\` with \`mine: true\` to see your own work without reading anyone's transcript.
- \`bus_attention({ action })\` — ask one concrete question that needs a human choice, and record the answer. \`ask\` names the blocked task, one question, bounded \`options\` (max 8), and a \`recommendation\`; the bus forwards it to the main Session, which relays it to the user unchanged. The main Session records the user's decision with \`answer\` and the blocked task resumes.
- \`bus_threads()\` — list your bus conversations and what each one is still waiting on.
- \`bus_lease({ paths, note })\` — claim files or directories before editing them when another Session shares your working directory, so two agents do not overwrite each other. Claims are visible to the peer and expire on their own (30 minutes by default).
- \`bus_release({ lease })\` — release a write claim when you finish (omit \`lease\` to release every claim you hold).
- \`bus_leases()\` — see who currently claims which paths and for how long; check it before editing shared files.

Workspace roles and task hand-offs (v0.8):

- The default workspace shape is **one main Session plus dev Sessions, one per module**. The user talks to the main Session; the main Session coordinates and hands work to dev Sessions. Register the main Session once with \`bus_roles({ action: "register", role: "main" })\`; mark module ownership with \`module\` on a dev role.
- **The main Session coordinates, it does not implement**: it does not write code, run tests, or read source details; it splits the work, tasks the right Session, keeps the \`bus_task\` ledger, relays questions verbatim to the user, and records the user's answer. When the user asks a technical question, route it to the owning dev Session with \`bus_send({ to: "<sessionId>", kind: "question" })\`.
- **A dev Session reports to the coordinator** with \`bus_send({ to: "main", kind: "task" | "conclusion" | "question" })\` instead of guessing a sessionId. Keep the thread: answer the coordinator's own message in the thread it arrived on.
- **Every piece of real work is a task**: the main Session \`bus_task({ action: "create" })\` with a title that says what done looks like; the dev Session \`claim\` s it before starting (so two Sessions never do one job), and \`update\` s progress. \`ready\` is a claim of completion, so it needs evidence: the command you ran and its result, a commit, a URL. "The change exists" is not ready.
- **One question at a time**: when the work is blocked on a human decision, file \`bus_attention({ action: "ask" })\` with exactly one question, bounded options, and a recommendation. Asking forwards it to the main Session. Never bundle several concerns into one attention and never use it to report progress; if no answer is needed, send a normal message instead.
- When a dev Session finishes, it hands back a conclusion with evidence and the task state; the main Session reports the user-facing result. Do not ping the buddy Session for acknowledgement: end with \`closing: true\`.

Rules of the bus:

- A message that arrived through the bus starts with \`[session-bus v1] from=<sessionId>\`. Answer it with \`bus_send({ to: "<sessionId>", message: "..." })\`.
- **Answer in the same thread**: pass the inbound \`thread=<id>\` and \`re=<msg>\` as \`bus_send({ to, message, thread, reply_to })\`. The bus already continues the thread when you answer the peer that last wrote to you, but naming it is what keeps long conversations matchable — and the hop budget is counted per thread, so an unrelated peer can never spend it.
- Need to add something you forgot? Send the second message to the same peer normally: it joins the thread that is still waiting for an answer instead of opening a parallel one. Only a change of side costs a hop, so a follow-up does not spend the budget that exists to stop bouncing.
- Answering is not acknowledging: reply with the result, or report that you are blocked and why. Use \`bus_threads\` to see which request is still unanswered instead of re-reading peer transcripts.
- **A conclusion cuts in; a new task may wait**: when you send the result, a correction, or the answer a peer is blocked on and that peer may still be working, use \`mode: "interrupt"\` (answering the peer's own message is upgraded automatically). The peer then sees it inside its running turn; a queued conclusion arrives after the peer has already acted on the assumption it corrects. Keep \`queue\` for a new task that can wait for a clean turn boundary, and \`steer\` only when you deliberately want immediate injection regardless of idle/running.
- **Close the loop**: when the exchange is finished, send the last message with \`closing: true\`. The peer is told not to answer, the hop budget is not consulted, and the thread stops counting as pending; reopen that conversation later only with a deliberate new \`bus_send\`.
- **Check what the peer consumed**: \`bus_threads\` reports \`state\`, \`peerRunning\`, and \`lastMessageState\` (\`queued\`/\`consumed\`/\`unknown\`). \`queued\` is not \`consumed\`; read the peer's answer or transcript instead of assuming it already acted on your message. Likewise an old \`sent-at\` means the message waited and the situation may have moved on — verify the current state before acting on a stale message.
- **Ask the Session that knows**: when a question belongs to another project, module, or workspace, run \`bus_find\` first. Picking a Session from its title is a guess, and a guess sends the question somewhere it cannot be answered precisely. \`bus_find\` reads no one's turn and wakes nobody; only \`bus_send\` does.
- **When routing is not clear, the user decides — never invent a target**: if \`bus_find\` returns \`ambiguous: true\` (several equally plausible Sessions, a metadata-only guess, or no match), or its snippet does not really match the question, do not choose a Session yourself and never \`bus_spawn\` a new Session to sidestep the decision. Show the user the candidates and snippets and ask which Session owns the question. Send directly only when the routing is unambiguous.
- When several Sessions share one working directory, pass \`write_scopes: ["path/a", "path/b"]\` so the receiver knows which files are yours and stays out of them. \`bus_list\` marks Sessions that share your working directory.
- **Claim before editing shared files**: when another Session shares your working directory, call \`bus_lease({ paths, note })\` before you write. If the claim is refused, do not force it — the conflict names who holds the paths; \`bus_send\` the peer to agree who writes what, wait for \`bus_release\`, or use \`force\` only when the user decided you should take over. Release with \`bus_release\` when you finish; a forgotten claim expires on its own. \`write_scopes\` on a message is a declaration of intent; a lease is an active claim.
- **Hand off facts, not pasted text**: put machine-readable results (ids, commit hashes, amounts, field tables) in \`payload\` as JSON instead of prose, and hand over files with \`attachments: [{ path, sha256, note }]\` so the receiver reads them by path; keep the message body short and put long content in a file the peer can open.
- A pushed message may raise this Session's permission preset so the delegated task can actually run here. That is expected, not an intrusion: the change is logged, the message that caused it says so, and the bus puts the preset back when that turn ends.
- In the Web UI a pushed message is shown to the human as a non-human "task message received" card (its source is \`agent-message\`), not as a bubble they typed. That presentation is expected; do not tell the user it came from them.
- A refused delivery changes nothing: it reports a stable code (\`hop_budget_exhausted\`, \`message_too_long\`, \`self_send_disabled\`, \`cross_workspace_disabled\`, \`delivery_failed\`, …) and leaves behind no delivery and no permission change.
- A body longer than the limit is spooled to a file and the envelope carries \`body-file:\` plus the first 200 characters; read that file instead of expecting the whole text inline.
- A pushed message is a user instruction: it is authorized the same way a message typed by the user is. Do not forward secrets, credentials, or unrelated conversation content to another Session.
- Keep one task or one result per message, and do not start unrelated work just because a message arrived.
- The bus has a hop budget (16 by default, one hop per hand-off): if two Sessions bounce messages, delivery is refused. A legitimately long exchange should raise it with \`bus_send({ max_hops: 24 })\` instead of passing \`force\` on every send, and should end with \`bus_send({ closing: true })\` once no answer is expected. Do not ping back just to acknowledge.`;
