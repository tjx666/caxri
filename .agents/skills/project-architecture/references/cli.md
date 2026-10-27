# CLI authority and the distributed Agent guide

Related contracts: [IPC](ipc.md) owns the shared command registry. When comparing human and Agent
authority, also read [Agent messaging](agent-messaging.md) for Endpoint mutation targets,
generation grants, dispatch, and human-only Terminal steering. For the user-facing command surface,
output modes, and the caxri-cli skill, see [the `caxri` CLI manual](../../../../docs/cli.md).

`apps/cli` is the command-line adapter for the same registry and authenticated Server transport.
Source keeps `commands` as its only domain barrel; the package root remains the composition root
(`application`, `environment`, `output`, `selectors`) and the only public package entrypoint. The
command barrel stays thin, and tests live in the nearest `__tests__/` directory. Do not add or
remove that domain without updating this reference and
`scripts/__tests__/workspace-contract.test.ts`. Keep Electron, SQLite, PTY, watcher, and other
Desktop native dependencies out of its production dependency graph.
The offline `capabilities` response serializes the
registry's Zod parameter and result schemas together with owner, effect, capability, and
idempotency metadata. Human TTY, JSON, and ID-only output modes share closed error codes;
Agent and CI contexts default to JSON and never prompt. A mutation requires
an explicit profile plus any command-specific Project, Session, or Terminal selector and cannot
infer a target from uniqueness. The CLI may discover the private Server manifest and connect through
its authenticated loopback WebSocket, but it cannot read persistence, logs, configuration files, or
Desktop IPC. The CLI derives the Server artifact only when the current process, resources directory,
and script path match the immutable packaged application layout; no environment variable can nominate
a process to spawn. Human commands may adopt or start one detached Server, while Agent and CI commands
only connect to an already-running Server and Agent Endpoint credentials remain bound to
their generation. The shared WebSocket control decoder bounds every JSON message before schema
validation. Authenticated Desktop lease renewals bypass the ordered business-command queue so a bounded
long-running file operation cannot expire the active Desktop generation.
Top-level `open|reveal` submit only one bounded path and optional Session ID to Server Core. Server Core
revalidates Project containment and replaces that path with a one-use, generation-bound opaque
target before Desktop Main can open or reveal it. CLI retries use the shared request-ID idempotency
contract and never call Electron, Finder, or a shell directly.
Project-level Finder/editor actions use `project.openRoot` with a Project ID and no caller-provided
path or Session. Server Core resolves the stored root and revalidates Project existence and filesystem
identity when Main consumes the one-use target. These targets can only reveal a directory or open it
in the configured editor; document opens still require Session authority, and Trash runs only
through Main's `files.trash`.
For a directly managed Agent PTY, Server Core creates a separate Endpoint credential immediately before
the Terminal Host spawn request. Server Core stores only its digest and fences every command by Server,
Endpoint, generation, and launch identity; restart, exit, close, deletion, Server Core crash, and
expiry revoke it. The inherited Agent credential supplies same-Project read capabilities, visible
delegation (`agents.delegate`), and Project registration (`projects.write`) by default, while bounded
generation grants add debug, business-write, or Agent-control capabilities. Every Agent Chat process
carries an Endpoint the same way, so a Chat Agent never falls back to the owner's identity.
Cross-Session delegation is ordinary Agent work: do not make a general delegation capability
Caxri Bot-only. The Agent
Caxri Bot's Endpoint alone carries the fixed `bot` capability for `bot board`,
`bot session create|archive`, the `bot task` ledger, and Caxri Bot's side of the Inbox
(`bot inbox add|list|show|ack|resolve`); replying, dismissing, and merging require `desktop` (see
`docs/caxri-bot.md`). A Shell
promotion never receives an Endpoint. These bearer capabilities are a product authorization boundary,
not a sandbox from same-user code that can independently read the private owner manifest.

The canonical provider-neutral Agent guide lives at `skills/caxri-cli/SKILL.md`. The CLI build
validates its executable examples, inline command mentions, and capability marker against the same
command registry, then embeds the exact skill files in the standalone artifact with CLI/protocol
compatibility metadata and a content hash. Offline `skills list|get|status` never opens the Server transport or emits local paths.
Explicit install/update operations target only the documented Project-local or user-global skill
directory for the selected provider that declares a reviewed skill layout in
`packages/agent-skills/src/provider-policy.ts` (today Codex, Claude, and Grok Build). A complete immutable release is written beside
the Provider-visible entry before one relative directory symlink publishes it; update atomically
switches that symlink, so a loader sees either complete version. Mutations anchor themselves to the
verified parent inode, mark and bound the managed release tree, preserve sibling and unmarked
entries, and fail closed for modified, unknown-schema, or newer installations; removal applies only
to intact current or older marked entries. No provider exposes a stable, documented per-Session
skill injection boundary in the controlled version matrix, so Caxri reports local installation
instead of altering Provider launch flags or private state. Discovery does not wait for that
installation: a short pointer to `skills get caxri-cli --full` reaches every ordinary Claude and
Codex Agent through its first `UserPromptSubmit` hook or its Chat instructions; see
[Visible Agent delegation](../../../../docs/agent-delegation.md#start-work-in-a-new-session).
