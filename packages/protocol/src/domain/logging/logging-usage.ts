/**
 * Usage ledger, pricing, and weekly usage guard events.
 */
export const usageLogEvents = {
    /**
     * The weekly usage guard (`AGENT_USAGE_GUARD_PERCENT`) changed or acted, with `provider` and a closed `outcome`
     * (`armed`, `window_reset`, `refused` with its closed `path`, `handoff_started`, `handoff_generated`,
     * `handoff_failed` with its closed `reason`). Never carries prompt, hand-off, or provider text.
     */
    guard: 'usage.guard',
    /**
     * A Chat's work continued in another Agent from a used-up plan limit or the weekly guard: source and target
     * `provider`, closed `trigger` (`usageLimit`, `usageGuard`), closed `outcome` (`created`, `existing`, `failed` with
     * the error `code`), and the duration. Never carries the context package.
     */
    continuation: 'usage.continuation',
    /**
     * A Chat's automatic continuation after a used-up plan limit resets changed state: `provider`, the limit `window`,
     * a closed `outcome` (`waiting`, `continued`, `rescheduled`, `missed`, `cancelled`, `skipped`, `failed`), the
     * closed `reason` of a cancellation or skip, the `attempt` count in this window, and `waitedMs` from the failure.
     * Never carries prompt or provider text.
     */
    autoContinue: 'usage.auto_continue',
    externalScan: 'usage.external_scan',
    /**
     * The user dismissed a provider's plan pace reminder from any Client, with `provider` and the weekly window's
     * `usedPercent` at that moment, so how often the reminder is dismissed, and how far behind pace, is measurable.
     */
    planPaceDismissed: 'usage.plan_pace_dismissed',
    pricing: 'usage.pricing',
    pullRequests: 'usage.pull_requests',
    scan: 'usage.scan',
} as const;
