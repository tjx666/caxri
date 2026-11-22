import type { AgentChatUsageLimit, UsageLimit } from '@caxri/protocol';

import type { AntigravityUsageAnswer } from '../../../agents';

/**
 * How long a `/usage` answer stands before the next read runs the command again. The status bar polls every 2 seconds
 * and each read spawns `agy`, while the quota moves slowly; a turn that ran into the limit reads afresh instead.
 */
export const ANTIGRAVITY_PLAN_LIMITS_REFRESH_MS = 60_000;

/**
 * How soon a `/usage` read that failed (timeout, spawn error) runs again.
 */
export const ANTIGRAVITY_PLAN_LIMITS_RETRY_MS = 10_000;

type PlanLimitsReading = Omit<UsageLimit, 'provider'>;

/**
 * An Antigravity Chat's plan windows from its CLI's own `/usage` command: at most one command at a time, a reading
 * reused for {@link ANTIGRAVITY_PLAN_LIMITS_REFRESH_MS}. A failed read keeps the last good reading and retries after
 * {@link ANTIGRAVITY_PLAN_LIMITS_RETRY_MS}; a signed-out read drops it, since those windows no longer apply.
 */
export class AntigravityPlanLimits {
    private reading: PlanLimitsReading | undefined;

    private readAt = -Infinity;

    private inFlight: Promise<PlanLimitsReading | undefined> | undefined;

    constructor(
        private readonly run: () => Promise<AntigravityUsageAnswer>,
        private readonly now: () => number = Date.now,
    ) {}

    private async refresh(): Promise<PlanLimitsReading | undefined> {
        try {
            const answer = await this.run();
            if (answer.status === 'unknown') {
                // A timeout or spawn failure says nothing about the quota: keep the last reading and try again
                // after a short pause instead of hiding the limit for the whole reuse window.
                this.readAt =
                    this.now() -
                    ANTIGRAVITY_PLAN_LIMITS_REFRESH_MS +
                    ANTIGRAVITY_PLAN_LIMITS_RETRY_MS;
                return this.reading;
            }
            this.readAt = this.now();
            this.reading = answer.status === 'signedIn' ? answer.limit : undefined;
            return this.reading;
        } finally {
            this.inFlight = undefined;
        }
    }

    /**
     * The current reading; `isFresh` skips the reuse window, for a turn that just ran into the limit.
     */
    read(isFresh = false): Promise<PlanLimitsReading | undefined> {
        if (!isFresh && this.now() - this.readAt < ANTIGRAVITY_PLAN_LIMITS_REFRESH_MS)
            return Promise.resolve(this.reading);
        this.inFlight ??= this.refresh();
        return this.inFlight;
    }
}

/**
 * Whether a quota group (`Gemini`, `Claude & GPT`) covers `model`, by one of the group's words appearing in the id.
 */
function isGroupOf(group: string | undefined, model: string | undefined): boolean {
    if (!group || !model) return false;
    const id = model.toLowerCase();
    return group
        .toLowerCase()
        .split(/[^a-z\d]+/u)
        .some((word) => word.length > 1 && id.includes(word));
}

/**
 * The used-up window a turn on `model` failed on: the latest-resetting full window of the model's quota group, or of
 * any group when none names the model. Without a full window the limit is unknown, as for a reading that failed.
 */
export function antigravityUsageLimit(
    reading: PlanLimitsReading | undefined,
    model: string | undefined,
): AgentChatUsageLimit {
    const full = (reading?.windows ?? []).filter((window) => window.usedPercent >= 100);
    const own = full.filter((window) => isGroupOf(window.group, model));
    const candidates = own.length > 0 ? own : full;
    let latest: (typeof full)[number] | undefined;
    for (const window of candidates)
        if (!latest || (window.resetsAt ?? 0) > (latest.resetsAt ?? 0)) latest = window;
    if (!latest) return { window: 'unknown' };
    return {
        window: latest.scope ?? 'unknown',
        ...(latest.resetsAt !== undefined && { resetsAt: latest.resetsAt }),
    };
}
