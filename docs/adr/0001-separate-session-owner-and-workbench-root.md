# Separate Session ownership from the Workbench Root

- Status: accepted
- Date: 2026-08-14
- Amended by: ADR 0005 (target, pending)

A Session keeps one immutable owning Project for identity, PrimarySidebar grouping, Terminals, Agent launch,
and Agent Endpoint authority, while an independently persisted Workbench Root selects the authorized
Project used by Files, Editor, Search, and Git. This separation lets an Agent-created linked worktree
become the visible work surface without moving or restarting the Agent process that created it.

Workbench state and dirty document identity are scoped by `(sessionId, workbenchProjectId)`. The
provider hook bridge classifies a bounded Bash command locally and reports only authenticated
worktree-create intent plus an opaque tool identifier, never its command, path, or output. Runtime
captures structured Git topology before that exact tool runs and compares it with a forced read after
the paired outcome. Only one unique addition can become a candidate. A missing pair, failed tool,
timeout, or ambiguous concurrent signal/addition is consumed and fails closed, while Main still
requires exact canonical native-folder authorization before an unknown worktree becomes a Project.
A missing or replaced active root falls back to the owning Project. This deliberately rejects the
simpler choices of mutating Session ownership, moving Terminal cwd, trusting a path reported by an
Agent or CLI, or sharing same-path editor state across worktrees.
