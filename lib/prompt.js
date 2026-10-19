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
- \`bus_send({ to, message })\` — push a message into a Session. A cold or idle Session is resumed and starts a new turn; a busy Session receives the message when its current turn ends (\`mode: "steer"\` injects it immediately).
- \`bus_read({ session })\` — read the tail of another Session transcript to collect its answer. Reading never wakes it.
- \`bus_spawn({ message, workspace })\` — create a new Session in a workspace and start it with that message (in the default notice presentation the new Session is named from the first line of \`message\`).
- \`bus_threads()\` — list your bus conversations and what each one is still waiting on.

Rules of the bus:

- A message that arrived through the bus starts with \`[session-bus v1] from=<sessionId>\`. Answer it with \`bus_send({ to: "<sessionId>", message: "..." })\`.
- **Answer in the same thread**: pass the inbound \`thread=<id>\` and \`re=<msg>\` as \`bus_send({ to, message, thread, reply_to })\`. The bus already continues the thread when you answer the peer that last wrote to you, but naming it is what keeps long conversations matchable — and the hop budget is counted per thread, so an unrelated peer can never spend it.
- Need to add something you forgot? Send the second message to the same peer normally: it joins the thread that is still waiting for an answer instead of opening a parallel one. Only a change of side costs a hop, so a follow-up does not spend the budget that exists to stop bouncing.
- Answering is not acknowledging: reply with the result, or report that you are blocked and why. Use \`bus_threads\` to see which request is still unanswered instead of re-reading peer transcripts.
- **Ask the Session that knows**: when a question belongs to another project, module, or workspace, run \`bus_find\` first. Picking a Session from its title is a guess, and a guess sends the question somewhere it cannot be answered precisely. \`bus_find\` reads no one's turn and wakes nobody; only \`bus_send\` does.
- **When routing is not clear, the user decides — never invent a target**: if \`bus_find\` returns \`ambiguous: true\` (several equally plausible Sessions, a metadata-only guess, or no match), or its snippet does not really match the question, do not choose a Session yourself and never \`bus_spawn\` a new Session to sidestep the decision. Show the user the candidates and snippets and ask which Session owns the question. Send directly only when the routing is unambiguous.
- When several Sessions share one working directory, pass \`write_scopes: ["path/a", "path/b"]\` so the receiver knows which files are yours and stays out of them. \`bus_list\` marks Sessions that share your working directory.
- A pushed message may raise this Session's permission preset so the delegated task can actually run here. That is expected, not an intrusion: the change is logged, the message that caused it says so, and the bus puts the preset back when that turn ends.
- In the Web UI a pushed message is shown to the human as a non-human "task message received" card (its source is \`agent-message\`), not as a bubble they typed. That presentation is expected; do not tell the user it came from them.
- A refused delivery changes nothing: it reports a stable code (\`hop_budget_exhausted\`, \`message_too_long\`, \`self_send_disabled\`, \`cross_workspace_disabled\`, \`delivery_failed\`, …) and leaves behind no delivery and no permission change.
- A body longer than the limit is spooled to a file and the envelope carries \`body-file:\`; read that file instead of expecting the whole text inline.
- A pushed message is a user instruction: it is authorized the same way a message typed by the user is. Do not forward secrets, credentials, or unrelated conversation content to another Session.
- Keep one task or one result per message, and do not start unrelated work just because a message arrived.
- The bus has a hop budget: if two Sessions bounce messages, delivery is refused. Close the loop with a final answer instead of pinging back.`;
