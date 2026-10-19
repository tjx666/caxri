import type { Query, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import type { UsageLimit } from '@caxri/protocol';

import { isRecord, stringField } from './chat-items';
import { withTimeout } from './claude-prompt-queue';

const PLAN_LIMITS_TIMEOUT_MS = 5_000;

/**
 * How long a `/usage` answer stands before the next read asks the process again. The status bar polls every 2 seconds;
 * the plan's percentages move slowly between turns, each answer costs Claude Code a request to its account service, and
 * a turn's `rate_limit_event`s keep the reading current in between.
 */
export const CLAUDE_PLAN_LIMITS_REFRESH_MS = 60_000;

/**
 * The plan windows Caxri shows, keyed as Claude Code's `/usage` answer names them, with each window's length.
 */
const PLAN_WINDOWS = [
    ['five_hour', 300],
    ['seven_day', 10_080],
] as const;

type PlanLimitsQuery = Pick<Query, 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'>;

type PlanLimitsReading = Omit<UsageLimit, 'provider'>;

/**
 * One Claude Chat's plan limits, read the way T3 Code reads them: ask the running process with `/usage`'s request at
 * most once per {@link CLAUDE_PLAN_LIMITS_REFRESH_MS}, and between asks apply the `rate_limit_event` the stream sends
 * whenever a turn changes a window. An event before the first answer is dropped: it carries one window and no plan, and
 * the next read asks anyway.
 */
export class ClaudePlanLimits {
    private reading: PlanLimitsReading | undefined;
    private askedAt = -Infinity;

    constructor(private readonly now: () => number = Date.now) {}

    async read(query: PlanLimitsQuery | undefined): Promise<PlanLimitsReading | undefined> {
        if (!query) return undefined;
        if (this.reading && this.now() - this.askedAt < CLAUDE_PLAN_LIMITS_REFRESH_MS)
            return this.reading;
        const answer = await readClaudePlanLimits(query, this.now());
        if (!answer) return this.reading;
        this.askedAt = this.now();
        this.reading = answer;
        return answer;
    }

    observe(info: SDKRateLimitInfo): void {
        if (!this.reading) return;
        const reading = claudeRateLimitEvent(this.reading, info, this.now());
        if (reading) this.reading = reading;
    }
}

/**
 * A claude.ai plan's 5-hour and weekly limits from the running Claude Code process, the data behind its `/usage`
 * command. The process answers with the credentials it already holds, so Caxri never reads the Keychain itself.
 * `skipBehaviors` leaves out the transcript scan the command's attribution section needs. Undefined for an API key or a
 * third-party provider, where plan limits do not apply, for a process that is not open (`query` undefined), and for any
 * answer that is late or not understood.
 *
 * The SDK marks this request experimental; a renamed or reshaped answer only makes the reading disappear.
 */
export async function readClaudePlanLimits(
    query: PlanLimitsQuery | undefined,
    now: number = Date.now(),
): Promise<Omit<UsageLimit, 'provider'> | undefined> {
    if (!query) return undefined;
    let answer: unknown;
    try {
        answer = await withTimeout(
            query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
                skipBehaviors: true,
            }),
            PLAN_LIMITS_TIMEOUT_MS,
        );
    } catch {
        return undefined;
    }
    return claudePlanLimits(answer, now);
}

/**
 * The plan limits in a `/usage` answer (untrusted), or undefined when it carries none.
 */
export function claudePlanLimits(
    answer: unknown,
    now: number,
): Omit<UsageLimit, 'provider'> | undefined {
    if (!isRecord(answer) || !isRecord(answer.rate_limits)) return undefined;
    const limits = answer.rate_limits;
    const windows = PLAN_WINDOWS.flatMap(([key, windowMinutes]) => {
        const window = limits[key];
        if (!isRecord(window)) return [];
        const used = window.utilization;
        if (typeof used !== 'number' || !Number.isFinite(used)) return [];
        const resetsAt = Date.parse(stringField(window.resets_at) ?? '');
        return [
            {
                windowMinutes,
                usedPercent: Math.min(100, Math.max(0, used)),
                ...(Number.isFinite(resetsAt) && resetsAt > 0 && { resetsAt }),
            },
        ];
    });
    if (windows.length === 0) return undefined;
    const plan = stringField(answer.subscription_type);
    return { observedAt: now, ...(plan && { planType: plan.slice(0, 64) }), windows };
}

/**
 * A reading with one window replaced by a `rate_limit_event`'s (untrusted) figures, or undefined when the event names a
 * window Caxri does not show or carries no figure. Unlike the `/usage` answer, the event's `utilization` is a 0 to 1
 * fraction and its `resetsAt` is in epoch seconds. A `rejected` status without a figure means the window is used up.
 */
export function claudeRateLimitEvent(
    reading: PlanLimitsReading,
    info: SDKRateLimitInfo,
    now: number,
): PlanLimitsReading | undefined {
    const windowMinutes = PLAN_WINDOWS.find(([key]) => key === info.rateLimitType)?.[1];
    if (windowMinutes === undefined) return undefined;
    const used =
        typeof info.utilization === 'number' && Number.isFinite(info.utilization)
            ? info.utilization * 100
            : info.status === 'rejected'
              ? 100
              : undefined;
    if (used === undefined) return undefined;
    const resetsAt =
        typeof info.resetsAt === 'number' && info.resetsAt > 0 ? info.resetsAt * 1000 : undefined;
    const window = {
        windowMinutes,
        usedPercent: Math.min(100, Math.max(0, used)),
        ...(resetsAt !== undefined && { resetsAt }),
    };
    const others = reading.windows.filter((existing) => existing.windowMinutes !== windowMinutes);
    return {
        ...reading,
        observedAt: now,
        windows: [...others, window].toSorted((a, b) => a.windowMinutes - b.windowMinutes),
    };
}
