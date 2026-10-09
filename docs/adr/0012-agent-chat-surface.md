---
kind: adr
status: accepted
---

# Agent Chat: a structured Terminal surface beside the PTY

- Date: 2026-10-09
- Refs: [#1529](https://github.com/tjx666/caxri/issues/1529)

Caxri launched every Agent CLI inside a real PTY and promised never to proxy or rewrite its I/O.
A TUI is the most faithful surface, but on the desktop it reads worse than the mobile Conversation
view: streamed Markdown, grouped tool calls, and approval cards are easier to scan than a scrolling
terminal grid. Users asked for that conversation reading experience on the desktop.

**Decision**: an Agent Terminal has a fixed **surface**, chosen when it is created: `pty` (today's
behavior) or `chat`. A Chat Terminal runs the same user-installed, unmodified Agent CLI through the
provider's own structured protocol and renders a conversation instead of a terminal grid. The
surface never changes after creation; a later change may add switching an idle Terminal by
resuming its Agent Session in the other surface, which the model below already allows.

- **Vendor protocols, not ACP.** Claude Code and Codex are the priority providers and neither ships
  native Agent Client Protocol support; ACP reaches them only through community adapters that wrap
  the same vendor protocols. Codex uses `codex app-server` (stdio JSON-RPC, the interface its own
  IDE extension uses). Claude Code will use the Claude Agent SDK pointed at the user's own `claude`
  binary. Grok remains PTY-only. ACP stays an option for a future long-tail provider that ships it
  natively.
- **A Chat Terminal is still a Terminal row.** It keeps Session ownership, Primary Agent election,
  Agent Session identity, naming, ordering, pane placement, and the `terminal` pane resource. A
  `surface` column distinguishes it. Features that need a PTY (input bytes, resize, snapshots,
  suspension, restore) reject a Chat Terminal at one central guard instead of growing a parallel
  entity: a separate table would have duplicated the Primary Agent foreign key, attention, naming,
  and about twenty pane-layout branches.
- **Server Core owns the provider child process.** Each live Chat Terminal owns one provider
  process spawned by Server Core with the same allowlisted environment as other Agent launches. It
  is a separate operating-system process, so a provider crash cannot take Server Core down. Terminal
  Host keeps owning PTYs only. When Server Core stops, its Chat processes stop with it; the next
  read or message resumes the Agent Session lazily, so restart does not relaunch idle Chats.
- **The provider's record stays the source of truth.** Caxri keeps a bounded in-memory projection
  of the current conversation and never persists messages, tool output, or reasoning. History comes
  back from the provider on resume. Streaming updates are transient events that never enter the
  durable journal, matching Terminal output in [ADR 0006](0006-durable-changefeed-and-streaming-protocol.md).
- **Authentication stays with the provider.** Caxri never offers a provider login, never reads or
  stores provider credentials, and never routes model traffic. A signed-out CLI reports its own
  error, and the user signs in with the CLI itself.

## Considered options

- **ACP for every provider.** One protocol client, but Claude Code and Codex would depend on
  third-party adapters that lag their CLIs and expose subagents, plans, and approvals only through
  extension metadata.
- **A read-only conversation view over the live PTY** (projected from transcripts). No principle
  change, but it cannot stream, answer approvals, or confirm that input became a turn; it would
  have remained a second-class reader.
- **A dedicated worker process for Chat runtimes.** Better isolation for an in-process SDK. Codex's
  app-server is already its own process, so the extra hop buys nothing yet; revisit when the Claude
  Agent SDK, which runs inside Node, is added.

## Consequences

The README product boundary changes from "Agent CLIs always run in a real PTY" to "Agent CLIs run
unmodified, in a real PTY or through their vendor's structured protocol". Chat Terminals do not
support PTY-only actions such as Terminal input from other Clients, Agent dispatch, or batch
compaction until each one gains an explicit structured path.
