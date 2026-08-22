# Separate Session ownership from the Workbench Root

- Status: accepted
- Date: 2026-08-14

A Session keeps one immutable owning Project for identity, PrimarySidebar grouping, Terminals, Agent launch,
and Agent Endpoint authority, while an independently persisted Workbench Root selects the authorized
Project used by Files, Editor, Search, and Git. This separation lets an Agent-created linked worktree
become the visible work surface without moving or restarting the Agent process that created it.

Workbench state and dirty document identity are scoped by `(sessionId, workbenchProjectId)`. A hook
is only a content-free timing signal: Runtime attributes a candidate from a unique structured Git
topology delta, and Main requires an exact canonical native-directory authorization before an
unknown worktree becomes a Project. Ambiguous concurrent deltas fail closed, and a missing or
replaced active root falls back to the owning Project. This deliberately rejects the simpler choices
of mutating Session ownership, moving Terminal cwd, trusting a path reported by an Agent, or sharing
same-path editor state across worktrees.
