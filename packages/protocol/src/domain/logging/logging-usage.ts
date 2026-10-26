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
    externalScan: 'usage.external_scan',
    pricing: 'usage.pricing',
    pullRequests: 'usage.pull_requests',
    scan: 'usage.scan',
} as const;
