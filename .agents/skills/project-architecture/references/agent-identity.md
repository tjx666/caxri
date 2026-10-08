# Agent identity, naming, and managed launches

Agent identity is a Renderer-wide typed registry rather than a per-surface icon choice. Managed provider Terminal titles and icon accessible labels derive from the shared provider catalog; provider-specific assets stay in one exhaustive icon map, while Shell, reserved Grok/OpenCode, and unknown identities remain local fallbacks. Terminal tabs, Project Session rows, creation choices, Terminal Info cards, and Settings resolve the same identity. Brand SVGs are emitted as local build assets; monochrome icons inherit the active theme, and unsupported future adapters use a deliberate generic fallback. The Session hover/focus card is a Renderer-only projection of existing Project, Session, and primary-Terminal metadata; it never reads Terminal output, source contents, Agent transcripts, prompts, credentials, or settings. The Info view lists only Terminals owned by the selected Session, including their process state, PID when live, directory, and correlated Agent session ID; installed tools that were not started in that Session never appear there.

The browser-safe Agent provider catalog owns provider identity, display metadata, executable names, and declared UI
capabilities. Generic schemas, Settings options, Renderer filters, invalidation, test isolation, and other provider-wide
consumers iterate that catalog. Server Core provider descriptors own launch behavior such as resume argv and local-state
adapters. Safety arguments, verified versions, messaging, lifecycle syntax, CLI skill installation, assets, and every
other provider-specific decision remain exhaustive `AgentProvider` policies so a catalog extension fails closed until
each owning layer records an explicit decision.

A bound Codex thread is resolved by its exact provider ID even when its stored cwd belongs to an earlier Worktree.
Unbound metadata discovery still requires the current cwd and a thread created after this Terminal launch. On macOS,
an unbound running Codex Terminal can also establish an old resumed identity through a bounded foreground-process
probe: exactly one valid rollout must be held writable beneath the configured canonical Codex sessions root. The
probe reads process and open-file metadata only, never rollout contents; ambiguous ownership, unavailable tools, and
expired Terminal generations leave the binding unchanged. Lifecycle hooks remain authoritative, and another
Terminal's claimed identity or a discarded fresh-start identity cannot be reclaimed through this fallback.

Codex and Claude Sessions can receive one Caxri-generated title after an authenticated main-turn completion supplies
useful conversation context. An existing native title with unknown provenance is preserved: only an explicitly
AI-generated title may be replaced. The naming service checks native ownership before generation, then reads a
bounded, provider-authorized transcript tail in Server memory,
selects visible user and assistant messages, and excludes instructions and tool records. It never uses Git branch
names. Unclear tasks defer naming; generation uses the existing isolated, tool-disabled provider text runner.
The first substantive user request determines the generated title's language; an issue-only or image-only request
uses the assistant's explanation. Generated titles are checked against that language and cannot be a bare issue key.
An invalid non-SKIP result gets one corrective generation attempt before naming defers to a later turn.
A transcript that still lacks a user or assistant message is re-read after 0.5, 2, and 8 seconds before naming
defers, because Claude Code's Stop hook can arrive a few milliseconds before the reply reaches the transcript.
An unknown-provenance native title that is only an issue key is treated as provisional under automatic ownership;
an explicitly user-owned native title remains authoritative.
`sessions.automatic_naming` persists the exact provider binding and pending title before native rename, then records
the provider-returned title and completion. Automatic and manual writes share the Session rename queue. Every async
boundary revalidates manual intent, archive state, primary binding, cwd, and launch identity; old work never follows a
new Agent binding. Matching pending readback completes a recovered intent without repeating `/rename`.

Completion ends generation for that Caxri Session, including after restart. Later native metadata may synchronize a
name but never triggers another write. Claude's transcript `custom-title` outranks `ai-title` and stale live metadata;
only `nameSource: user` is an explicit metadata fallback. Newer explicit external renames acquire manual ownership,
while AI titles and pre-write snapshots cannot undo Caxri's completed rename. Codex does not persist title provenance:
an existing non-provisional native name stops Caxri generation while keeping native-to-Caxri synchronization active.
This protects a first-turn native manual rename without guessing from text, and also retains generic native AI titles.
A manual rename through Caxri is always protected. Codex's provisional first-prompt prefix remains filtered inside
the native SQLite query, so raw prompts never become displayed names.

Manual rename remains user-owned. `session.rename` resolves the exact primary Agent identity, sends the requested
name through the provider's public rename boundary, and commits that exact request to SQLite inside a per-Session
queue so a slower earlier request cannot overwrite a newer one. A provider may choose a different native title when
the name is already held by another live session; Caxri records the mismatch without displaying that fallback as the
user's Session name. Manual rename sets `title_mode` to `manual`, which stops the metadata probe from replacing the
user's title with a later provider-native one. The Renderer shows the requested name as soon as the user commits it
and keeps it over snapshot reads until the request settles, because a Claude rename waits seconds for the provider
CLI; if the newest rename fails, the previous name returns with the failure toast. The Server fences automatic naming
when the request arrives, not when it commits, so an automatic title cannot land in that window. The Claude CLI call
is capped at 60 seconds only to keep a hung process from holding the Session's rename queue.

Automatic titles use a macOS `sandbox-exec` profile that
denies reads of the Project root and of the global instruction files the CLI offers no switch for (`AGENTS.md` and
`AGENTS.override.md` for Codex, `CLAUDE.md` and `CLAUDE.local.md` for Claude), because an isolated working directory
alone cannot reach a file the CLI resolves from its own configuration directory. The conversation and model output
never enter logs, events, diagnostics, SQLite, or UI.

Long Terminal pastes never reach a model here. The original is saved to an owner-only local file and the Agent receives
its path plus a note that a summary can be delegated to a subagent, because a model call on the paste path holds
Terminal input until it returns.

Preflight rejects ancestor Projects containing required provider/runtime paths. Instruction denials
cover both link entries and resolved targets; only missing instruction files are tolerated. A blocked
automatic-naming launch emits one notice and does not retry until a new launch. See
[Low-cost generation sandbox](../../../../docs/low-cost-generation.md) for recovery and threat-model limits.

Every managed Agent inherits the public, non-authorizing `CAXRI_MANAGED_AGENT=1` marker, which a user's own hook script
may read to skip its work inside Caxri. A personal provider hook (including a personal session-naming hook) is
preserved untouched across install and removal; Caxri owns only its own marked entries.

`Terminal.title` is the stable semantic title: Agent metadata promotes it to the conversation title,
while Shell OSC 0/2 remains isolated in the live `Terminal.ptyTitle`. Once a Terminal binds an Agent
provider, Server Core discards later OSC titles instead of persisting or broadcasting state with no
consumer. A directly managed Agent Endpoint uses the provider catalog title until metadata
establishes an `agentSessionId`, then uses the conversation title on later generations. Endpoint
names are fixed when a generation begins; Caxri does not expose a dynamic rename protocol.

A Shell Terminal can become an Agent Terminal when its unpublished input line launches `claude` or
`codex`, either directly or through a shell alias. Terminal Host keeps a simple-command candidate in
memory for a bounded window and confirms aliases from the PTY's active foreground process group using a
fixed, bounded `ps` query; compound commands and background processes are excluded. Every candidate gets
five one-second probes; only a direct Agent command then keeps probing with backoff until the window closes,
because a slow exec can outlast the fast retries and metadata never restores a same-provider relaunch's
process state. Once the provider executable is confirmed, Server Core promotes the durable Terminal
atomically so its shared icon and title update even before the provider writes session metadata. A later
same-Project, unclaimed metadata session created after command submission supplies the Agent session ID
and generated title. Shell input
and process-list output are never logged or persisted, and ordinary output alone does not infer Agent
identity.

An Agent Terminal keeps one interactive Shell as its PTY root and starts the configured Agent as a managed
foreground child. The Shell process defines the Terminal lifecycle, while `lastAgentProcessState` records
whether an interactive Agent is starting, running, or stopped in that Terminal; managed control is fenced
separately by the in-memory launch ID and Agent process ID. Agent exit therefore returns to the same live Shell
without emitting `terminal.exit`; only the Shell root exiting stops the Terminal. Durable
provider, title, and Agent session identity remain attached to the Terminal so a later explicit resume can
start another managed generation. If another Agent Terminal in the same Session is still live, it becomes the
primary Agent when the current primary exits; without a live successor, the stopped Terminal stays primary so its
durable identity remains the resume target. A manually launched foreground Agent receives no managed identity or control;
bounded process probes only publish and later revoke its interactive availability.
Long-paste preparation returns an explicit native-paste result for these manually launched Agents before
saving or summarizing text. Managed Agents retain generation-fenced summaries and file-reference fallback;
preparation errors never trigger native-paste fallback. Managed startup supports zsh and bash; when the configured platform Shell is
unsupported, Agent Terminals use macOS's system zsh while ordinary Shell Terminals keep the configured executable.
`terminal.restart`, Resume, and Fresh deliberately replace the Shell PTY too:
injecting a command into an existing prompt could append to an unpublished edit or disrupt foreground job control.
Ordinary Agent exit never replaces the Shell; this explicit restart boundary is the safe exception.

Desktop batch compaction is owned by `session.compactWarm` in Server Core. It estimates prompt-cache
freshness from bounded native usage, requires submission-to-completion input proof, and sends only to
the exact live primary Agent generation. See [Batch Session compaction](../../../../docs/session-compaction.md)
for the estimates, skip reasons, and live-TUI ownership boundary.
