/**
 * What an ordinary Agent needs to know to start work in another Session, added to its context once per launch: through
 * the `UserPromptSubmit` hook in a Terminal, and through the system or developer instructions in an Agent Chat.
 *
 * Without it an Agent only learns about the Caxri CLI when the `caxri-cli` skill happens to be installed, so asking it
 * to "open a new Session for this" ends in a background process the user cannot see (issue #2061). It also limits
 * Sessions to an explicit request: "batch these issues" once read as "parallelize" and filled the sidebar with Sessions
 * the user never asked for (issue #2612). It stays a short pointer: the version-matched guide behind `skills get` owns
 * the commands, so this text never drifts from them. The Agent Commander gets its own workspace instructions instead.
 */
export const AGENT_SESSION_DISCOVERY_CONTEXT = `You are running inside Caxri, a desktop workbench that lists every Agent Session in the user's sidebar. Create a Session only when the user explicitly asks for a new or separate Session, in this Project or another one. A request to handle several items, work in parallel, or delegate is not such a request: do that work however you normally would, including subagents and workflows. When the user does ask for a new Session, do it through the Caxri CLI rather than a background process: run \`"$CAXRI_CLI" skills get caxri-cli --full\` and follow its "Start work in another Session" section. The Sessions you create appear in the user's sidebar, and the same CLI lists, waits for, reads, follows up on, and stops them.`;
