---
kind: living
status: current
---

# Usage limits and cross-Agent continuation

When a provider account runs out of plan usage, the work in a Chat should not stop with it. Caxri
handles two moments: a turn that already failed on a used-up limit (recovery), and a weekly window
that is about to run out (the weekly usage guard). Both end in the same action: continue the Chat's
work in a new Session of the same Project with another Agent. Both are Chat-first; the PTY Terminal
surface is not guarded yet.

Contract: `packages/protocol/src/agent/agent-usage-continuation.ts`. Server owners:
`apps/server/src/domains/usage/usage-guard.ts` (the guard) and
`apps/server/src/domains/agent-chat/continuation/` (classification, the brief, and continuation).

## Recovery from a used-up limit

- **Classification.** Claude Code reports a rejected `five_hour` or `seven_day` rate-limit event and
  then a synthetic "You've hit your … limit" reply; Codex fails the turn with
  `usageLimitExceeded`. Either marks the turn's error notice with `usageLimit` (`session`,
  `weekly`, or `unknown`, plus `resetsAt` when known). The synthetic reply is the failure, not an
  answer, so it is not shown as an Agent message.
- **Recovery card.** The notice names the window and its reset, keeps the provider's own words muted
  beneath, and offers `Continue in <Agent>`: a split button whose leading half names the first
  Agent that can take over, with a list of every other Agent. An Agent that cannot take over is
  listed disabled with why: not installed or its own account is at the guard
  (`agentChat.continuationTargets`). Waiting for the reset needs no control.
- **Continuation.** `agentChat.continueInAgent` is owner-only and Server-owned. It creates a
  delegation with `newSession` and `handoff` from the source Chat, so the new Session reuses the
  existing `Continued from` and `Continued in` cards. The delegation id is a deterministic UUID of
  the source Terminal and the failed turn (or the guard window), so a retry, a double click, or a
  restart opens the same Session instead of creating another. A launch that fails before its Agent
  starts removes the empty Session and returns `UNAVAILABLE`.
- **The brief.** The new Agent's first message is built from the Chat's projection without asking
  the source provider anything (`continuation-brief.ts`): why the work moved, what to verify first
  (`git status`), the latest request, the plan, the files changed, and the newest conversation that
  fits the delegation prompt budget. Reasoning text and control characters are dropped.

## Weekly usage guard

- **Arming.** Any reading of the provider's general weekly window (a transcript, `/usage`, or a live
  rate-limit event) at or above `AGENT_USAGE_GUARD_PERCENT` (99) with a future `resetsAt` arms the
  guard for that provider account. Only a window the provider names as its weekly one counts, never a
  model-specific window of the same length. The guard is persisted in `app_state`
  (`agentUsageGuards`), so a restart keeps it, and it lifts itself at `resetsAt`.
- **What it blocks.** Every ordinary model request on that account fails with `USAGE_LIMITED`:
  Chat send, steer, queued follow-ups, slash commands, side questions, delegation, dispatch, Session
  auto-naming, and idle compaction. Arming interrupts the account's running turns (recorded as
  stopped by the usage guard) and pauses their follow-up queues with reason `usageGuard`; the reset
  resumes them.
- **What the user can still do.** The composer shows the guard card: how much of the week is used,
  when it resets, and two ways forward. `Generate hand-off` (`agentChat.generateHandoff`) spends the
  kept budget on one tool-less turn in which the Chat's own model writes a hand-off document; the
  lease is one per account per weekly window, shared by every Chat of that account. `Open in another
Agent` continues from the deterministic package, with the hand-off document first when one exists.
  There is deliberately no "Continue anyway".
- **Mobile** shows the blocked state as a banner and disables send. **The Agent Commander window**
  has no Workbench to show a new Session, so it offers the hand-off but no continuation.

## Observability

Both events are content-free and use closed enums (`packages/protocol/src/domain/logging/logging-usage.ts`):

- `usage.guard`: `provider` and `outcome` (`armed`, `window_reset` with its duration, `refused` with
  its closed `path`, `handoff_started`, `handoff_generated`, `handoff_failed` with its closed
  `reason`).
- `usage.continuation`: source and target `provider`, `trigger` (`usageLimit`, `usageGuard`), and
  `outcome` (`created`, `existing`, `failed` with the error `code`), with the duration.

Neither carries prompt, hand-off, transcript, or provider text.
