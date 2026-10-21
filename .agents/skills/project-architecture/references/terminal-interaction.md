# Terminal input, links, layout, and actions

Files and Editor drops insert a shell-escaped path relative to a running Agent's verified
`agentCwd`, falling back to the Terminal's launch `cwd`. After the Agent child exits, the surrounding
shell uses launch `cwd` even if Agent metadata retains the worktree. Switching the visible Workbench Root alone does not
change an existing Terminal's reference base. Server Core publishes a Terminal record change when
`agentCwd` is set or cleared, independently of Workbench Root follow policy. Workspace symlinks
retain their entry paths and use copy-only reference payloads, so dragging a link cannot enable Files move operations.
Files dropped from another application, such as Finder, follow the same rule, one space-separated argument per file.
The Renderer cannot read their paths, so the preload resolves each `File` with `webUtils.getPathForFile`
(`CaxriBridge.pathForFile`); a file promise with no path on disk inserts nothing and raises a warning instead.
`features/terminal/terminal-drop.ts` owns the drop-to-input rule for both the Workbench pane and the Agent Commander.

The Client binary-stream writer reserves one validated payload larger than the ordinary burst budget
separately from that bounded burst. A concurrent resize or small input can queue before or after a large
paste without consuming its allowance; a second large payload is rejected until the first settles.
WebSocket callback backpressure and the socket high-water mark still apply to every chunk.

A mobile Terminal size change is explicit and leased by Terminal Host under a separate generation-bound
capability. While the lease is active, Desktop attach and resize update the latest desired Desktop grid
without changing the PTY. Release, disconnect, unsubscribe, device revocation, timeout, or Terminal
retirement ends the lease; a running PTY returns to the current Desktop grid, or to its pre-lease grid
when no Desktop view remains. Only one exact connection and subscription holder can own the lease.
Terminal Host emits `terminal.sizeOwnership` after a takeover, mobile size change, release, timeout,
or Desktop attach. Core forwards only the current PTY generation; the public event carries owner
and actual grid without holder identity and stays out of durable replay. Desktop applies the actual
mobile grid to xterm, keeps sending its fitted grid for Host to cache, and shows a non-obscuring
status row until ownership returns. A fresh attach re-emits current ownership for late views and
reconnects.
Mobile control input crosses a separate Host request fenced to the current PTY generation; it never
borrows the Desktop attachment capability. Revocation cancels input awaiting Host startup before
send; once sent, the Host result remains authoritative because PTY input cannot be recalled.
Mobile Composer submission uses a separate exact-Agent Host operation, bounded to 16 KiB of valid
UTF-8 text without terminal control bytes. Host queues bracketed paste text and then a separate
Return, checking the managed Agent child before each write under the current PTY generation and
launch. Its patched node-pty writer reports completion only after each write reaches the PTY master;
a discarded, partial, or unacknowledged write is unknown and is never retried. On Agent exit, Host
atomically stops new PTY input, discards queued writes, and waits for any in-flight write callback
before acknowledging the launcher. The launcher suppresses terminal echo, drains the inherited PTY
input queue through a nonblocking `/dev/tty` read, and reports that drain before Host resumes input
for the same PTY generation. If Host transport fails before its acknowledgement, the launcher stays
foreground in raw mode and periodically discards input; close the affected Terminal to recover.
This keeps unread Agent input from becoming a zsh or bash shell command.

Terminal attachment recovery belongs to the Client binary-stream boundary: `TIMEOUT` and
`UNAVAILABLE` can leave both Host ownership ambiguous and the output socket closed. Retry with fresh
tickets and streams at most twice, after 250 ms and 1 s, under the same cancellable Terminal operation
lease. Detach, Terminal close, or disconnect cancels backoff; input is never retried. Server snapshot
reply ordering prevents failed streams from leaking output into replay. Do not roll back ambiguous Host
ownership or retry only a Host request behind a closed Client stream.

Terminal file-link detection forwards the raw text, owning Terminal ID, and optional editor location
without giving Renderer filesystem access. Server Core tries exact absolute, current Workbench Project,
and persisted Terminal-cwd candidates first. When an ordinary relative path is incomplete, a bounded
directory suffix search may resolve it only inside the current Workbench Project; one complete
result opens directly, while incomplete or ambiguous results require the Renderer candidate picker.
An explicit `.../` prefix opts into the same bounded suffix search across every authorized Project.
Current-user `~/...` links expand only in Server Core, which rejects escape and targets that are neither a regular file nor a directory and
reuses a canonical Project that already contains the file. For a Project-contained target Main selects
the unique target Session, creates a no-Terminal Session when none exists, or requires a native choice
when the target Project has multiple reasonable Sessions; that open uses Server Core's one-use Desktop
target, whose approved root/file identity becomes an expected identity that Server Core compares with
its first `files.authorizeOpen` result and revalidates again when Main redeems the target. An explicit
absolute, `file://`, `./`, `../`, or `~/` target outside every Project (OSC 8 hyperlinks carry the
absolute URI even when their label reads `~/...`) is reported as `external` without being read. Main
then reuses the free-path browser's external snapshot: it confirms once with Open / Trust Folder and
Open / Cancel, or skips the prompt when the `security.trustedFolders` setting already contains the
file's folder, reads one bounded no-follow snapshot, and the Renderer opens it as an ephemeral editable
tab in the Terminal's own Session (saves and desktop actions follow the external document rules in
`files-and-paths.md`). Trusting a folder persists only that prompt-skip preference; it never creates a
Project, grants Files, Search, or Git authority over the folder, or makes the tab durable.
A Project-contained exact target may also be a directory: `terminal.fileLink.resolve` returns `kind: 'file' | 'directory'`
(suffix-search candidates are always files), and Main sends a directory to `desktop.openProject` with the same expected
identity instead of `desktop.openFile`. The Workbench treats a `directory` `desktop.openRequested` that carries a path below the
Session root as "select the Session, show the Files ViewContainer, select and expand the directory" (the Session root
itself only selects the Session, as `caxri open <project>` always did). Chat prose and user messages link a rooted
(`/` or `~/`) path with at least one directory segment even without an extension (`/repo/.local-config`, `/repo/Makefile`);
relative paths and one-segment tokens such as `/model` still need an extension to read as files.
Home expansion and suffix search never create a permanent single-file exception or a Renderer filesystem
capability.

Hovering a detected commit sha or GitHub reference opens the existing affordance popup with that
reference's own metadata above the `⌘ click …` line. Only those two kinds are read: a configured
reference rule already carries everything its card shows, and a file path would cost a Project-wide
suffix search on an involuntary gesture. The Renderer coalesces concurrent hovers onto one read,
cancels it through `requests.cancel` when the last waiter leaves, and caches bounded results; remote
strings render as text, never markup. Server Core resolves the Project from the Terminal, so
Renderer cannot submit a local repository or cwd. A GitHub reference is read for any github.com
repository, because Agent Chat links pull requests in sibling repositories through the same method;
the protocol holds `owner` and `repo` to GitHub name characters (`isGitHubName`) so untrusted text
cannot reshape the REST path, and `gh api --hostname github.com` pins the host. Nothing rejects: every miss returns
an `unavailable` card with a closed, separately actionable reason, logged as that enum rather than
the CLI's message. See `docs/terminal-reference-preview.md`.

Terminal groups form a persisted binary split tree with horizontal or vertical direction and a bounded
ratio. Dragging a tab moves its durable Terminal ID between groups or creates a new split; shared
reducers collapse empty groups and validate that one Terminal cannot appear twice. Moving a view may
detach and reattach xterm, but the Terminal Host-owned PTY is neither restarted nor duplicated.
Keyboard-adjustable separators and group labels preserve accessible focus semantics.

The active Terminal's Status Bar metrics are sampled by Terminal Host. A fixed `ps` argv reads only PID,
PPID, and RSS for the live PTY process tree every two seconds while that Terminal is visible; Renderer
receives aggregate memory and descendant count, never commands or environment data. Sampling stops when
a file tab is active and an exited PTY returns no usage.

Default `Command+Shift+K`, `Command+T`, and `Command+W` bindings clear the active xterm view, create a Terminal in the active group, and close the active Terminal through its normal lifecycle. Clear moved off `Command+K` because that chord is the reserved opener for two-chord sequences; see [docs/keybindings.md](../../../../docs/keybindings.md). `Command+Shift+Enter` configures Tab followed by LF when a Terminal owns focus; the VS Code-compatible `sendSequence` command normalizes that LF to Return before accepting the active completion and submitting it. Clear is Renderer-local and never sends input or a signal to the PTY. All bindings remain configurable, and app-wide commands are ignored while a modal dialog is open. Command-backed native menu items derive placement, ordering, labels, and accelerators from the shared command catalog and live keybindings; only standard Electron role items stay explicit in Main. Static command descriptors default to Renderer-registry execution and explicitly mark View-catalog execution so tests can prove that every shared command has exactly one route. Released default-keybinding generations remain compatibility fixtures: reviewed migrations must resolve their persisted command IDs to the current executable catalog without rejecting extension or user-defined commands. The Server Core owns the unified ViewContainer/View/Command descriptor catalog. Builtin React surfaces and extension Tree Views use the same selection, command, and persistence path; Renderer only dispatches the descriptor's `viewKind`.

`workbench.action.terminal.sendSequence` is an argument-required keybinding command: `args.text` is decoded by JSONC, normalizes CRLF and LF to Return like VS Code's `sendText`, and sends every other byte unchanged through the existing typed `terminal.input` path to the active PTY. `sendSequence` stays bounded to 65,536 characters, while direct xterm input accepts one bounded 1,048,576-character payload and Server Core splits it into ordered, surrogate-safe private Host requests. The lower-level `terminal.input` contract remains byte-preserving so direct xterm input, Ctrl+J, and multiline paste keep their original meaning. Keybindings may use the `terminalFocus` context so the chord falls through outside xterm. Contextual bindings are dispatched in the Renderer and do not become Electron native-menu accelerators because Main cannot evaluate DOM focus; source order remains authoritative, and the first binding whose context matches wins. Argument-required commands stay out of the Command Palette and cannot be added as an incomplete binding by the structured shortcut editor, but a complete source-authored binding remains visible and its chord remains editable there.

The Agent Actions picker targets one captured, running Agent Terminal. A typed `agentActions.list` read asks Server Core to derive provider-owned discovery roots from the Terminal's durable provider, cwd, and authorized Project; Renderer cannot submit a filesystem root. Server Core traverses only bounded canonical roots, rejects symlink escape, reads bounded scalar frontmatter metadata without returning source bodies or paths, then applies provider defaults, discovered items, and explicit user overrides in that order. The resulting list is capped at 256. Insert and run both reuse the existing structured `terminal.input` method as append-only PTY writes. An exhaustive provider-and-action-kind plan sends inserts, commands, and Claude Code skills in one write; Codex skills use one invocation write, a 150ms paste-burst settle window, then a Tab-plus-Return write to accept the completion and submit the composer. No method reads, clears, or replaces the current draft. See [Agent Actions](../../../../docs/agent-actions.md).
