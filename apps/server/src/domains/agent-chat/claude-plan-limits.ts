import type { Query, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import type { UsageCredits, UsageLimit } from '@caxri/protocol';

import { isRecord, stringField } from './chat-items';
import { withTimeout } from './claude-prompt-queue';
import { isClaudeOverageAllowed } from './continuation/claude-usage-limit';

const PLAN_LIMITS_TIMEOUT_MS = 5_000;

/**
 * How long a `/usage` answer stands before the next read asks the process again. The status bar polls every 2 seconds;
 * the plan's percentages move slowly between turns, each answer costs Claude Code a request to its account service, and
 * a turn's `rate_limit_event`s keep the reading current in between.
 */
export const CLAUDE_PLAN_LIMITS_REFRESH_MS = 60_000;

/**
 * The plan windows Caxri shows, keyed as Claude Code's `/usage` answer names them, with each window's length and scope.
 * `seven_day` is the account's general weekly window; the per-model ones (`seven_day_opus`, ...) are not shown.
 */
const PLAN_WINDOWS = [
    ['five_hour', 300, 'session'],
    ['seven_day', 10_080, 'weekly'],
] as const;

type PlanLimitsQuery = Pick<Query, 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'>;

type PlanLimitsReading = Omit<UsageLimit, 'provider'>;

/**
 * What a {@link ClaudePlanLimits} reports beyond its readings.
 */
interface ClaudePlanLimitsOptions {
    /**
     * Sees every `rate_limit_event`, including one that arrives before the first `/usage` reading.
     */
    onEvent?: (info: SDKRateLimitInfo) => void;
    /**
     * Sees whether extra usage is on, from each `/usage` answer that says.
     */
    onExtraUsage?: (isEnabled: boolean) => void;
    now?: () => number;
}

/**
 * One Claude Chat's plan limits, read the way T3 Code reads them: ask the running process with `/usage`'s request at
 * most once per {@link CLAUDE_PLAN_LIMITS_REFRESH_MS}, and between asks apply the `rate_limit_event` the stream sends
 * whenever a turn changes a window. An event before the first answer is dropped: it carries one window and no plan, and
 * the next read asks anyway.
 */
export class ClaudePlanLimits {
    private reading: PlanLimitsReading | undefined;
    private askedAt = -Infinity;
    private readonly now: () => number;

    constructor(private readonly options: ClaudePlanLimitsOptions = {}) {
        this.now = options.now ?? Date.now;
    }

    async read(query: PlanLimitsQuery | undefined): Promise<PlanLimitsReading | undefined> {
        if (!query) return undefined;
        if (this.reading && this.now() - this.askedAt < CLAUDE_PLAN_LIMITS_REFRESH_MS)
            return this.reading;
        const raw = await askClaudeUsage(query);
        const isExtraUsageEnabled = claudeExtraUsageEnabled(raw);
        if (isExtraUsageEnabled !== undefined) this.options.onExtraUsage?.(isExtraUsageEnabled);
        const answer = claudePlanLimits(raw, this.now());
        if (!answer) return this.reading;
        this.askedAt = this.now();
        this.reading = answer;
        return answer;
    }

    observe(info: SDKRateLimitInfo): void {
        this.options.onEvent?.(info);
        if (!this.reading) return;
        const reading = claudeRateLimitEvent(this.reading, info, this.now());
        if (reading) this.reading = reading;
    }
}

/**
 * The running Claude Code process's `/usage` answer (untrusted), the data behind its `/usage` command: a claude.ai
 * plan's 5-hour and weekly limits and its extra usage. The process answers with the credentials it already holds, so
 * Caxri never reads the Keychain itself. `skipBehaviors` leaves out the transcript scan the command's attribution
 * section needs. Undefined for an answer that is late or fails.
 *
 * The SDK marks this request experimental; a renamed or reshaped answer only makes the reading disappear.
 */
async function askClaudeUsage(query: PlanLimitsQuery): Promise<unknown> {
    try {
        return await withTimeout(
            query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
                skipBehaviors: true,
            }),
            PLAN_LIMITS_TIMEOUT_MS,
        );
    } catch {
        return undefined;
    }
}

/**
 * Whether a `/usage` answer (untrusted) reports extra usage as on, or undefined when it does not say (an API key, a
 * third-party provider, or a plan without extra usage). Claude Code reports `is_enabled` false while extra usage cannot
 * cover a request.
 */
export function claudeExtraUsageEnabled(answer: unknown): boolean | undefined {
    if (!isRecord(answer) || !isRecord(answer.rate_limits)) return undefined;
    const extra = answer.rate_limits.extra_usage;
    return isRecord(extra) && typeof extra.is_enabled === 'boolean' ? extra.is_enabled : undefined;
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
    const windows = PLAN_WINDOWS.flatMap(([key, windowMinutes, scope]) => {
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
                scope,
            },
        ];
    });
    if (windows.length === 0) return undefined;
    const plan = stringField(answer.subscription_type);
    const credits = claudeExtraUsageCredits(limits.extra_usage);
    return {
        observedAt: now,
        ...(plan && { planType: plan.slice(0, 64) }),
        windows,
        ...(credits && { credits }),
    };
}

/**
 * Claude Code's extra usage in a `/usage` answer (untrusted) as credits: what is left of the member's monthly cap, in
 * major units of its currency, or undefined while extra usage is off. The answer counts `monthly_limit` and
 * `used_credits` in minor units (cents for USD, the currency it means when it names none); an enabled account without a
 * cap has credits with no balance to show. The same object backs the "Extra usage" section of Claude Code's `/usage`
 * and CodexBar's Claude extra usage figure.
 */
export function claudeExtraUsageCredits(extra: unknown): UsageCredits | undefined {
    if (!isRecord(extra) || extra.is_enabled !== true) return undefined;
    const cap = extra.monthly_limit;
    if (typeof cap !== 'number' || !Number.isFinite(cap)) return { unlimited: false };
    const named = stringField(extra.currency)?.toUpperCase();
    const currency = named ?? 'USD';
    // A currency whose minor unit is unknown cannot be shown as an amount; the account still has credits.
    if (!/^[A-Z]{3}$/.test(currency)) return { unlimited: false };
    const used =
        typeof extra.used_credits === 'number' && Number.isFinite(extra.used_credits)
            ? extra.used_credits
            : 0;
    return {
        unlimited: false,
        balance: Math.max(0, cap - used) / 10 ** minorUnitDigits(currency),
        currency,
    };
}

const minorUnits = new Map<string, number>();

/**
 * How many digits a currency's minor unit has (2 for USD, 0 for JPY), as `Intl` knows it.
 */
function minorUnitDigits(currency: string): number {
    let digits = minorUnits.get(currency);
    if (digits === undefined) {
        digits =
            new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
                .maximumFractionDigits ?? 2;
        minorUnits.set(currency, digits);
    }
    return digits;
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
    const planWindow = PLAN_WINDOWS.find(([key]) => key === info.rateLimitType);
    if (!planWindow) return undefined;
    const [, windowMinutes, scope] = planWindow;
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
        scope,
    };
    const others = reading.windows.filter((existing) => existing.windowMinutes !== windowMinutes);
    const { credits: known, ...rest } = reading;
    return {
        ...rest,
        observedAt: now,
        windows: [...others, window].toSorted((a, b) => a.windowMinutes - b.windowMinutes),
        ...withEventCredits(known, info),
    };
}

/**
 * The credits a reading keeps after a `rate_limit_event`: extra usage the event reports as answering keeps the `/usage`
 * balance (or has credits without one), extra usage it reports as rejected has none left, and an event that does not
 * mention it leaves the reading's credits as they were.
 */
function withEventCredits(
    known: UsageCredits | undefined,
    info: SDKRateLimitInfo,
): { credits?: UsageCredits } {
    if (isClaudeOverageAllowed(info)) return { credits: known ?? { unlimited: false } };
    if (info.overageStatus === 'rejected') return {};
    return known ? { credits: known } : {};
}
