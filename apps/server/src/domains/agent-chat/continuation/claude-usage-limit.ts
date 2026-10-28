import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import type { AgentChatUsageLimit, AgentUsageLimitWindow } from '@caxri/protocol';

/**
 * Claude Code's plan windows by the scope Caxri reports when one of them is used up. The per-model weekly windows are
 * weekly limits too; `overage` is extra usage beyond the plan, whose window Claude Code does not name.
 */
const CLAUDE_LIMIT_WINDOWS: Record<
    NonNullable<SDKRateLimitInfo['rateLimitType']>,
    AgentUsageLimitWindow
> = {
    five_hour: 'session',
    seven_day: 'weekly',
    seven_day_opus: 'weekly',
    seven_day_sonnet: 'weekly',
    seven_day_overage_included: 'weekly',
    overage: 'unknown',
};

/**
 * Whether a `rate_limit_event` (untrusted) says extra usage (overage) still answers requests past the plan's windows.
 */
export function isClaudeOverageAllowed(info: SDKRateLimitInfo): boolean {
    return (
        info.overageStatus === 'allowed' ||
        info.overageStatus === 'allowed_warning' ||
        info.isUsingOverage === true ||
        info.overageInUse === true
    );
}

/**
 * The usage limit a `rate_limit_event` (untrusted) reports as used up, or undefined when it still allows requests. A
 * `rejected` window that overage still covers is not used up: Claude Code keeps answering on extra usage.
 */
export function claudeRejectedUsageLimit(info: SDKRateLimitInfo): AgentChatUsageLimit | undefined {
    if (info.status !== 'rejected') return undefined;
    if (isClaudeOverageAllowed(info)) return undefined;
    const window = (info.rateLimitType && CLAUDE_LIMIT_WINDOWS[info.rateLimitType]) ?? 'unknown';
    const resetsAt =
        typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) && info.resetsAt > 0
            ? Math.round(info.resetsAt * 1000)
            : undefined;
    return { window, ...(resetsAt !== undefined && { resetsAt }) };
}

/**
 * Remembers which plan windows Claude Code last reported as used up, so a failed turn can be told apart from an
 * ordinary rate limit, overload, network, or authentication error: Claude Code reports a used-up window as a `rejected`
 * `rate_limit_event`, while those other failures carry no such event. The event comes when a window's state changes,
 * not with every turn, so a window stays used up until an event allows it again (the user bought more usage) or its
 * reset time passes. Adapted from T3 Code's Claude adapter, which classifies a turn the same way.
 */
export class ClaudeUsageLimitTracker {
    private readonly rejected = new Map<string, AgentChatUsageLimit>();

    constructor(private readonly now: () => number = Date.now) {}

    observe(info: SDKRateLimitInfo): void {
        const key = info.rateLimitType ?? 'unknown';
        const limit = claudeRejectedUsageLimit(info);
        if (limit) this.rejected.set(key, limit);
        else this.rejected.delete(key);
    }

    /**
     * The used-up limit a failing turn ran into: the weekly one when several are used up, since it resets last.
     */
    current(): AgentChatUsageLimit | undefined {
        const now = this.now();
        for (const [key, limit] of this.rejected)
            if (limit.resetsAt !== undefined && limit.resetsAt <= now) this.rejected.delete(key);
        const limits = this.rejected.values().toArray();
        return limits.find((limit) => limit.window === 'weekly') ?? limits[0];
    }
}
