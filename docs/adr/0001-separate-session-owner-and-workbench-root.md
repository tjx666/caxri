# Separate Session ownership from the Workbench Root

- Status: accepted
- Date: 2026-08-14
- Amended by: ADR 0005 (target, pending)

A Session keeps one immutable owning Project for identity, PrimarySidebar grouping, Terminals, Agent launch,
and Agent Endpoint authority, while an independently persisted Workbench Root selects the authorized
Project used by Files, Editor, Search, and Git. This separation lets an Agent-created linked worktree
become the visible work surface without moving or restarting the Agent process that created it.

Sidebar Project path actions retain the owning Project identity: Copy Path and dragging into a
Terminal use its absolute root, while Reveal in Finder and Open Project in Editor work even without
Sessions. Project drags insert a shell-quoted argument without executing it or participating in Files
move operations. Session editor actions instead resolve the clicked Session's current Workbench Root.

The `project.openRoot` request accepts only a Project ID and a Finder/editor choice. Server Core reads
the stored root, rejects symbolic-link replacements, and issues the same bounded, generation-bound,
single-use Desktop target used for Session paths. Consumption checks that the Project still exists and
the root identity is unchanged. It neither creates a Session nor changes selection.

Workbench state and dirty document identity are scoped by `(sessionId, workbenchProjectId)`. The
provider hook bridge classifies a bounded Bash command locally and reports only authenticated
worktree-create intent plus an opaque tool identifier, never its command, path, or output. Runtime
captures structured Git topology before that exact tool runs and compares it with a forced read after
the paired outcome. Only one unique addition can become a candidate. A missing pair, failed tool,
timeout, or ambiguous concurrent signal/addition is consumed and fails closed. Choosing Continue
authorizes the exact Server-owned candidate through a single-use Main grant without a folder picker.
The prompt displays the destination, but its command submits only the opaque candidate ID. Server
revalidates the candidate and linked-worktree topology before registering its Project.
Pending suggestions have no time-based expiry: returning to a Session later must still allow
Continue or Not Now. Elapsed time is not evidence that a worktree disappeared; authorization
checks its current directory and repository membership when the user chooses Continue.

A manually resumed Agent can inherit the Terminal's Shell hook generation after its managed child
exits. Its first classified creation hook establishes repository identity within the same bounded
PreToolUse budget as the before-snapshot. Every asynchronous step and the final candidate check
retain a predicate for the current hook generation. This restores detection without treating a
Shell-lifetime topology change or a retired child's hook as proof of Session ownership.

Hook diagnostics distinguish ordinary commands from worktree-create intent even when they share a
phase; command text and reported directories never enter the log.

A missing or replaced active root falls back to the owning Project. This deliberately rejects the
simpler choices of mutating Session ownership, moving Terminal cwd, trusting a path reported by an
Agent or CLI, or sharing same-path editor state across worktrees.
