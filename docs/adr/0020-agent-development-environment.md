---
kind: adr
status: accepted
---

# Caxri is an Agent Development Environment

- Date: 2026-10-27
- Refs: [#2718](https://github.com/tjx666/caxri/issues/2718)
- Amends: [ADR 0015](0015-chat-primary-agent-surface.md) (the Terminal surface's role)

Caxri's positioning had drifted across the README, the glossary, and individual ADRs. The README
still called it "not an agent wrapper ... or an orchestration platform" while Chat drives Agents
through their vendors' protocols and the Agent Commander delegates work to other Agents. Without one
stated position, every feature decision re-derived the product from scattered precedent.

**Decision**: Caxri is an Agent Development Environment (ADE): the environment in which a developer
builds software through coding Agents. It keeps exploring what the best Agent development experience
is while Agents change quickly, so it ships often and adapts to the Agents it hosts instead of
freezing a workflow. The product principles say what Caxri gives its user; the development principles
say how Caxri itself is built. A feature, surface, or contributor practice that contradicts one of
them needs a stated reason.

## Product principles

1. **Keep pace with the Agents.** When Claude Code, Codex, or another hosted Agent changes, Caxri
   adapts quickly. Claude Code and Codex are the first-priority Agents; others follow.
2. **One experience across Agents.** The same action works the same way for every Agent. This is a
   principle, not a parity gate: when an Agent lacks a capability, that Agent goes without the
   feature for now rather than holding it back for the others.
3. **Make the subscription work for the user.** Caxri ships automation around plan limits and prompt
   caches that works out of the box and does not interrupt: compacting an eligible idle Chat before
   its cache expires, resuming a turn on its own after a known usage-limit reset, keeping 5-hour
   windows rolling. When automation cannot finish the job, such as a plan that has run out, Caxri
   offers the next step (continuing the work with another Agent) instead of leaving the user to
   work it out. Prefer doing a step automatically over asking the user to do it.
4. **Attention first.** The interface shows only what a developer still needs to see while Agents do
   the work, such as which Session needs them, what an Agent changed, whether it worked, and how much
   plan usage is left. A surface that only mirrors internal state or recreates a traditional IDE
   panel does not earn its place.
5. **Built for Agents to drive, not people.** Workflows are designed for Agents to drive through the
   `caxri` CLI and its skill; a person's controls review, steer, and decide rather than redo Agent
   work. Caxri provides no manual commit workflow, because committing is Agent work. A pull request
   merge button is the deliberate exception: merging is the decision a person still makes.
6. **Chat is the core mode.** New Agent capabilities target Chat, and the PTY Terminal surface may
   enter stable maintenance, where it stops receiving new Agent features. Its launch, input, resume,
   surface switch, suspension, and restore paths stay supported either way, and a regression there
   is still a bug.

## Development principles

1. **Built entirely by coding Agents.** Architecture, engineering infrastructure, checks, and
   documentation are designed for autonomous Agent discovery, execution, verification, and recovery.
2. **Observable to Agents.** Logs, metrics, and diagnostics give an Agent enough structured
   information to investigate a failure and find an optimization autonomously: closed reason enums,
   durations, per-lifetime aggregates, and state transitions
   ([ADR 0008](0008-agent-native-observability.md)). The privacy boundary does not move: diagnostics
   still exclude source contents, Terminal output, transcripts, credentials, and environment values.
3. **Server first.** Features live in the Server; Desktop, CLI, and Mobile are Clients of it
   ([ADR 0004](0004-independently-deployable-server.md),
   [ADR 0005](0005-multi-client-state-ownership.md)). A capability built inside one Client only is
   the exception and needs a reason.
4. **Adapt fast, carry no compatibility weight.** Until the first declared compatibility release,
   follow the Agents' changes directly instead of keeping adapters for earlier builds.
5. **Fast, light, consistent, simple, modern.** Favor high performance and low resource use, one
   consistent interface language across surfaces ([DESIGN.md](../../DESIGN.md)), the simplest design
   that works, and current platform practice over legacy patterns.

## Considered options

- **A focused workbench beside the IDE**, the previous README framing. It undersold Chat, delegation,
  and subscription automation, and its "not an orchestration platform" boundary contradicted shipped
  features.
- **Strict feature parity across Agents.** It would stall every Claude Code or Codex improvement on
  the least capable provider, which conflicts with keeping pace with the first-priority Agents.

## Consequences

Shared workflows are unified without requiring identical provider-specific optimizations. Idle
compaction covers Claude Code and Grok Build and leaves out Codex because a ChatGPT sign-in keeps the
Codex prompt cache without expiry, so there is nothing to save; that is a provider reason. A
difference between Agents with no such reason is a gap to close, not product policy. The Terminal
surface keeps the no-regression guarantee from [ADR 0015](0015-chat-primary-agent-surface.md); only
its claim on new features may change.
