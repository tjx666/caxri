---
kind: living
status: current
---

# Usage limits and cross-Agent continuation

When a provider account runs out of plan usage, the work in a Chat should not stop with it. Caxri
handles two moments: a turn that already failed on a used-up limit (recovery), and a weekly window
that is about to run out (the weekly usage guard). Both offer the same action: continue the Chat's
work in a new Session of the same Project with another Agent, which the user can also choose at any
time from a menu (see [Continue on request](#continue-on-request)). A failed turn whose limit resets soon
also continues on its own in the same Chat once the reset passes. All of it is Chat-first; a PTY
Terminal only shows the guard (see [PTY Terminals](#pty-terminals)) and is never blocked.

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

## Continue on request

The same continuation works without a limit, for a user who wants another Agent to take the work
over (a second opinion, a provider better at the task):

- **Entries.** `Continue in Another Agent` is a submenu in a Chat tab's context menu, for that tab's
  Agent, and in a Session row's context menu beside `Fork Session`, for the Session's Primary Agent.
  A non-primary Agent is reachable only from its own tab. The submenu lists the same targets as the
  recovery card, unavailable ones disabled with why; it is disabled with a reason while the Agent is
  open in a PTY or has no conversation yet, and absent for a Shell.
- **Contract.** `agentChat.continueInAgent` with `manual: true`. Server Core refuses a running turn
  or a compaction with `CONFLICT`, as Fork Session does, since the brief would miss the turn's end.
  The delegation id is keyed by the Chat's latest turn, so a double click reuses the Session while
  a later turn can continue again. The brief says the user handed the work over instead of naming a
  limit.
- **Not covered:** a persistent `Continued in` link on the source Chat. The destination's first
  message carries the `Continued from` link back.

## Automatic continuation after the reset

`agentChat.autoContinueAtUsageLimit` (default on) lets a Chat that failed on a used-up limit carry on
by itself once the limit resets (issue #2220). Owner: `continuation/chat-usage-limit-waits.ts`.

- **When it waits.** The failed turn's notice must carry a `resetsAt` within
  `AGENT_CHAT_AUTO_CONTINUE_HORIZON_MS` (24 hours), and the account must not be at the weekly usage
  guard. Otherwise the notice says why it will not continue (`skipped`: reset unknown, reset too far
  away, attempts used, or the usage guard). The wait fires 30 to 120 seconds after the reset, a
  random stagger so several Chats on one account do not hit the provider in the same second.
- **Where it shows.** Besides the notice's clock line, a waiting Chat's Terminal record carries
  `usageLimitWaitAt` (runtime-only, projected from the wait record). Desktop's Session list and
  Activity view show a clock in the status slot with "Continues automatically at <time>", outranking
  the failed or unread cue the limit left; every wait transition pushes `state.changed` for the
  Terminal, so the cue returns in one push when the wait ends. The phone receives the field but does
  not render it yet.
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
- **Ending a wait.** The card offers `Continue now` and `Cancel` while waiting, on Desktop and on
  the phone's usage-limit card alike (`mobile.agentChat.usageLimitWait`, reply access). A message the user
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
- **Another window.** A reading below the guard whose weekly `resetsAt` differs from the guard's by an
  hour or more lifts it: a later reset means the week rolled over early (`window_reset`), an earlier
  one can only be another account's week after the user signed in to it (`window_changed`). A lower
  reading of the same window keeps the guard, and a reading of a window that already reset is
  ignored.
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
  `UsageLimit.creditsNoticeDismissedAt` (`weeklyCreditsNotice`). The phone shows the same notice
  above its composer and dismisses it through `mobile.agentChat.dismissUsageNotice`.
- **What it blocks.** Every ordinary model request on that account fails with `USAGE_LIMITED`:
  Chat send, steer, queued follow-ups, slash commands, side questions, delegation, dispatch, Session
  auto-naming, and idle compaction. Arming interrupts the account's running turns (recorded as
  stopped by the usage guard) and pauses their follow-up queues with reason `usageGuard`; the reset
  resumes them. The interrupted turn itself continues after the reset when it fits the 24-hour
  horizon (see [Turns the guard stopped](#turns-the-guard-stopped)).
- **What the user can still do.** The composer shows the guard card: how much of the week is used,
  when it resets, and the ways forward. `Generate hand-off` (`agentChat.generateHandoff`) spends the
  kept budget on one tool-less turn in which the Chat's own model writes a hand-off document; the
  lease is one per account per weekly window, shared by every Chat of that account. `Open in another
Agent` continues from the deterministic package, with the hand-off document first when one exists.
  `Continue anyway` (`agentChat.bypassUsageGuard`) admits the account's requests for the rest of the
  window: the record stays, marked `bypassed`, so a later reading of the same window does not arm it
  again, and the paused queues resume. Clicking the card's headline folds the rest of it, hand-off
  document included, remembered per Chat for the window's lifetime.
- **Mobile** shows the guard as a card at the top of the Chat with the same headline, reset, wait
  line, and hand-off document, and disables send. Its `Generate hand-off`, `Cancel`, and `Continue
anyway` forward through `mobile.agentChat.generateHandoff`, `mobile.agentChat.usageLimitWait`, and
  `mobile.agentChat.bypassUsageGuard` (reply access, like sending); without reply access or offline
  the buttons are disabled with the reason beneath them. Continuing in another Agent stays in the
  Session menu's `Continue in Another Agent…`. **Caxri Bot window**
  has no Workbench to show a new Session, so it offers the hand-off but no continuation.

### PTY Terminals

A PTY Agent runs the provider CLI directly, so the guard is informational there (issue #2608). While the
provider's account is at the guard, Server Core projects `TerminalRecord.usageGuard` (`usedPercent`,
`resetsAt`; runtime-only, PTY Agent Terminals only) and pushes `state.changed` for those Terminals when the
guard arms or lifts (`usage/terminal-usage-guard-push.ts`). The pane shows a one-line row above the recovery
row (`terminal/terminal-usage-guard.tsx`): the weekly usage, the reset, and that the Terminal keeps running.
A new PTY Agent Session of that provider shows the same row from its first frame. Nothing is refused: a
running PTY is not interrupted, `--resume` still works, and input is not intercepted. There is no hand-off or
`Open in another Agent` in a PTY, because the continuation brief is built from a Chat's projection.

### Turns the guard stopped

A turn that Caxri's own guard interrupted (`stoppedBy: 'usageGuard'`, status `interrupted`; a turn that
finished before the stop landed never counts) continues after the window resets, as a 5-hour failure
does (issue #2733). It reuses the same `ChatUsageLimitWaits` record with `source: 'usageGuard'`, so the
stagger, the 30-minute `missed` rule, the attempt cap, the `usageLimitWaitAt` clock in the Session list,
and the hidden continue prompt are the same.

- **When it waits.** `guard.resetsAt` within `AGENT_CHAT_AUTO_CONTINUE_HORIZON_MS` (24 hours), with
  the setting on. Beyond that the guard card says `Won't continue automatically` and the wait is
  `skipped` with `resetTooFar`; the week is not waited for, as the user may have left. Unlike a 5-hour
  failure, an armed guard does not skip the wait: the guard lifting is what it waits for. If a new
  weekly window re-arms the guard at the due time, the wait is `skipped` with `usageGuard` and sends
  nothing.
- **Where it shows.** While the guard holds, `AgentChatUsageGuard.autoContinue` and
  `autoContinueTurnId` put the wait line and a `Cancel` on the guard card (no `Continue now`: the
  guard still refuses requests). When the guard lifts, the stopped turn gets a notice
  (`usageLimit.trigger: 'usageGuard'`) with the usual `Continues automatically at ...` card; a history
  replay re-adds it while the wait is `waiting` or `missed`.
- **Queued messages.** If the guard's reset releases queued follow-ups, they continue the Chat
  themselves: the wait ends (`cancelled`, reason `queueResumed`) and no hidden prompt is sent.
- **Cancel paths** are the 5-hour wait's: Cancel, a user message, `Open in another Agent`, the
  setting turned off, closing or archiving the Terminal, or switching to the PTY surface.
- **Not covered:** PTY Terminals, and a reset beyond 24 hours.

## Observability

All four events are content-free and use closed enums (`packages/protocol/src/domain/logging/logging-usage.ts`):

- `usage.guard`: `provider` and `outcome` (`armed` with `resetsInMs`, the distance to the window's reset, `window_reset` or `credits_available` with its
  duration, `refused` with
  its closed `path`, `handoff_started`, `handoff_generated`, `handoff_failed` with its closed
  `reason`).
- `usage.credits_notice_dismissed`: `provider` and the weekly window's `usedPercent` when the user
  hid the credits notice.
- `usage.continuation`: source and target `provider`, `trigger` (`usageLimit`, `usageGuard`,
  `manual`), and
  `outcome` (`created`, `existing`, `failed` with the error `code`), with the duration.
- `usage.auto_continue`: `provider`, `window`, `trigger` (`usageLimit`, `usageGuard`), `attempt`, and `outcome` (`waiting`, `continued`,
  `rescheduled`, `missed`, `skipped` or `cancelled` with its closed `reason`, `failed` with the
  error `code`), with the time waited.

None carries prompt, hand-off, transcript, or provider text.
