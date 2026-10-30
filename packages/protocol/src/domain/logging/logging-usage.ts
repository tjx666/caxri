/**
 * Usage ledger, pricing, and weekly usage guard events.
 */
export const usageLogEvents = {
    /**
     * The weekly usage guard (`AGENT_USAGE_GUARD_PERCENT`) changed or acted, with `provider` and a closed `outcome`
     * (`armed` with `resetsInMs`, how far the window's reset is, `window_reset`, `window_changed` (a reading of an
     * earlier-resetting window, another account) or `credits_available` with how long it held, `bypassed` (the user's
     * "Continue anyway") with `usedPercent` and how long it held, `refused` with its closed `path`, `handoff_started`,
     * `handoff_generated`, `handoff_failed` with its closed `reason`). Never carries prompt, hand-off, or provider
     * text.
     */
    guard: 'usage.guard',
    /**
     * A Chat's work continued in another Agent from a used-up plan limit, the weekly guard, or the user's menu: source
     * and target `provider`, closed `trigger` (`usageLimit`, `usageGuard`, `manual`), closed `outcome` (`created`,
     * `existing`, `failed` with the error `code`), and the duration. Never carries the context package.
     */
    continuation: 'usage.continuation',
    /**
     * A Chat's automatic continuation after a used-up plan limit or the weekly guard resets changed state: `provider`,
     * the limit `window`, the closed `trigger` (`usageLimit`, `usageGuard`), a closed `outcome` (`waiting`,
     * `continued`, `rescheduled`, `missed`, `cancelled`, `skipped`, `failed`), the closed `reason` of a cancellation or
     * skip, the `attempt` count in this window, and `waitedMs` from the failure. Never carries prompt or provider
     * text.
     */
    autoContinue: 'usage.auto_continue',
    externalScan: 'usage.external_scan',
    /**
     * The user dismissed a provider's plan pace reminder from any Client, with `provider` and the weekly window's
     * `usedPercent` at that moment, so how often the reminder is dismissed, and how far behind pace, is measurable.
     */
    planPaceDismissed: 'usage.plan_pace_dismissed',
    /**
     * The user dismissed a provider's credits notice (weekly window at the usage guard, account working on credits)
     * from any Client, with `provider` and the weekly window's `usedPercent`.
     */
    creditsNoticeDismissed: 'usage.credits_notice_dismissed',
    pricing: 'usage.pricing',
    pullRequests: 'usage.pull_requests',
    scan: 'usage.scan',
} as const;
