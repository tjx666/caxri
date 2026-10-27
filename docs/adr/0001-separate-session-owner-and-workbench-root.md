---
kind: adr
status: accepted
---

# Separate Session ownership from the Workbench Root

- Date: 2026-08-14
- Amended by: ADR 0005 (target, pending)

A Session keeps one immutable owning Project for identity, PrimarySidebar grouping, durable Terminal ownership,
Agent authorization, and Agent Endpoint authority, while an independently persisted Workbench Root selects the
authorized Project used by Files, Editor, Search, Git, and the default cwd of newly created Terminals. This
separation lets an Agent-created linked worktree become the visible work surface without moving or restarting the
Agent process that created it; only later Terminal launches follow the newly selected root.

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
worktree-create intent plus an opaque tool identifier, never its command, path, or output. Server
Core captures structured Git topology before that exact tool runs and compares it with a forced read after
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
simpler choices of mutating Session ownership, moving an existing Terminal cwd, trusting a path reported by an
Agent or CLI, or sharing same-path editor state across worktrees.

"Replaced" is decided by the stored inode, not by the stored device number. A device number is a
property of the current mount, not of the directory: macOS re-allocates every volume's `/dev` node on
boot, so a persisted `st_dev` stops matching after an ordinary restart while the directory is
untouched. Treating that as a replacement discarded every Workbench Root at once. The inode carries
the durable half of the identity: a worktree removed and re-added, or a directory recreated at the
same path, gets a new one, and the callers that compare it have already proved through Git topology
and `realpath` that the path is the owning repository's linked worktree and not a symbolic link. A
binding whose device drifted alone is re-anchored onto the current device and logged as
`workbench_root.rebound`, without publishing a root change the user did not cause. An in-flight
Agent worktree follow therefore compares the selected Project and inode across asynchronous checks;
the device re-anchor does not cancel a follow that still belongs to the same root.
