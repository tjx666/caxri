---
kind: living
status: current
---

# Usage limits and cross-Agent continuation

When a provider account runs out of plan usage, the work in a Chat should not stop with it. Caxri
handles two moments: a turn that already failed on a used-up limit (recovery), and a weekly window
that is about to run out (the weekly usage guard). Both offer the same action: continue the Chat's
work in a new Session of the same Project with another Agent. A failed turn whose limit resets soon
also continues on its own in the same Chat once the reset passes. All of it is Chat-first; the PTY
Terminal surface is not guarded yet.

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
  (`agentChat.continuationTargets`). Below the reset line, the card shows the automatic
  continuation and its controls (next section).
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

## Automatic continuation after the reset

`agentChat.autoContinueAtUsageLimit` (default on) lets a Chat that failed on a used-up limit carry on
by itself once the limit resets (issue #2220). Owner: `continuation/chat-usage-limit-waits.ts`.

- **When it waits.** The failed turn's notice must carry a `resetsAt` within
  `AGENT_CHAT_AUTO_CONTINUE_HORIZON_MS` (24 hours), and the account must not be at the weekly usage
  guard. Otherwise the notice says why it will not continue (`skipped`: reset unknown, reset too far
  away, attempts used, or the usage guard). The wait fires 30 to 120 seconds after the reset, a
  random stagger so several Chats on one account do not hit the provider in the same second.
- **What it sends.** Nothing the user wrote. Claude Code gets a fixed hidden prompt asking it to pick
  up where it left off; its uuid carries a marker (`queued-prompt-uuid.ts`) so a history replay
  hides it too. Codex starts a turn with empty input, which runs the model on the thread as it
  stands; the empty user item it echoes is dropped. Before sending, the Chat reads its plan limits
  (Claude Code's `/usage` reading; Codex's `account/rateLimits/read`, whose general `codex` limit
  is read with `excludeResetCreditDetails` and a 10-second timeout): a window still used up with a
  later reset moves the wait there (logged as `rescheduled`) instead of failing a turn into it. A
  read that fails or times out continues as planned.
- **Attempts.** Each continuation that fails into the limit again counts toward
  `AGENT_CHAT_AUTO_CONTINUE_MAX_ATTEMPTS` (3); the last one is `skipped` with `attemptsUsed`.
  Human input resets the count.
- **Ending a wait.** The card offers `Continue now` and `Cancel` while waiting. A message the user
  sends, `Continue in <Agent>`, turning the setting off, switching the Terminal to the PTY surface,
  or closing, deleting, or archiving it also ends it. A cancelled wait does not arm again for the
  same notice, and one that ends while the plan limits are read before sending sends nothing.
- **Missed.** A wait more than 30 minutes past its time (the Mac slept, or Server Core was not
  running), a Chat busy with a pending request, a queued follow-up, or a held queue, or a start that
  fails, becomes `missed`: the card offers `Continue` and never retries by itself, because a
  timed-out start may still have reached the provider.
- **Persistence.** The latest wait per Terminal lives in `app_state` (`agentChatUsageLimitWaits`), so
  a restart keeps it. Claude Code's transcript keeps no failed-turn notice, so a replay re-adds the
  notice while its wait is `waiting` or `missed`. A 15-second sweep fires due waits one Chat at a
  time.

## Weekly usage guard

- **Arming.** Any reading of the provider's general weekly window (a transcript, `/usage`, or a live
  rate-limit event) at or above `AGENT_USAGE_GUARD_PERCENT` (99) with a future `resetsAt` arms the
  guard for that provider account. Only a window the provider names as its weekly one counts, never a
  model-specific window of the same length. The guard is persisted in `app_state`
  (`agentUsageGuards`), so a restart keeps it, and it lifts itself at `resetsAt`.
- **Credits.** A reading that reports usable pay-as-you-go credits never arms the guard and lifts an
  armed one, because the account keeps working past its weekly window by spending them. Codex reports
  `credits` (unlimited, or a positive balance) in every rate-limit reading. Claude Code reports extra
  usage in its `/usage` answer (`rate_limits.extra_usage`: enabled, monthly cap and spend in minor
  units), read as the cap's remainder in its currency, and in each `rate_limit_event`
  (`overageStatus` allowed, or overage in use, keeps the account on credits; `rejected` takes them
  away). A reading with a zero balance protects the last percent again.
- **Credits notice.** While the weekly window is at the guard and the account has usable credits,
  the composer shows a one-line notice in place of the guard card: `Codex weekly usage at 99%:
requests continue on credits, 1,250 left` (Claude: `... on extra usage, $37.40 left this month`).
  Nothing is paused, and the pace reminder gives way to it. Its close button hides it for a day
  (`CREDITS_NOTICE_DISMISS_MS`) on every Client: `usage.dismissNotice` with `notice: 'credits'`
  keeps the time in `app_state` (`creditsNoticeDismissals`), returned as
  `UsageLimit.creditsNoticeDismissedAt` (`weeklyCreditsNotice`). The phone does not show it yet.
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
- **Mobile** shows the blocked state as a banner and disables send. **Caxri Bot window**
  has no Workbench to show a new Session, so it offers the hand-off but no continuation.

## Observability

All four events are content-free and use closed enums (`packages/protocol/src/domain/logging/logging-usage.ts`):

- `usage.guard`: `provider` and `outcome` (`armed`, `window_reset` or `credits_available` with its
  duration, `refused` with
  its closed `path`, `handoff_started`, `handoff_generated`, `handoff_failed` with its closed
  `reason`).
- `usage.credits_notice_dismissed`: `provider` and the weekly window's `usedPercent` when the user
  hid the credits notice.
- `usage.continuation`: source and target `provider`, `trigger` (`usageLimit`, `usageGuard`), and
  `outcome` (`created`, `existing`, `failed` with the error `code`), with the duration.
- `usage.auto_continue`: `provider`, `window`, `attempt`, and `outcome` (`waiting`, `continued`,
  `rescheduled`, `missed`, `skipped` or `cancelled` with its closed `reason`, `failed` with the
  error `code`), with the time waited.

None carries prompt, hand-off, transcript, or provider text.
