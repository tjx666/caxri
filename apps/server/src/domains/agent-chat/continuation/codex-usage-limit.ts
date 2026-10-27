import type {
    AgentChatSnapshot,
    AgentChatUsageLimit,
    AgentUsageLimitWindow,
    UsageLimit,
} from '@caxri/protocol';

import { isRecord, stringField } from '../chat-items';

type Json = Record<string, unknown>;

/**
 * Codex's account-wide limit; any other `limitId` is a model-specific limit.
 */
const CODEX_GENERAL_LIMIT_ID = 'codex';

/**
 * Codex's own status line names a window by its length; the same tolerance absorbs a server rounding the minutes.
 */
function codexWindow(minutes: unknown): AgentUsageLimitWindow {
    if (typeof minutes !== 'number') return 'unknown';
    const isAbout = (target: number) => Math.abs(minutes - target) <= target * 0.05;
    if (isAbout(300)) return 'session';
    if (isAbout(10_080)) return 'weekly';
    return 'unknown';
}

interface CodexWindowReading {
    window: AgentUsageLimitWindow;
    usedPercent: number;
    resetsAt?: number;
}

/**
 * Whether a turn error (untrusted, from an `error` notification or a failed turn) is Codex refusing the turn because
 * the plan's usage limit is used up. Codex reports a plain rate limit (`rateLimitExceeded`), overload, and connection
 * failures under their own names.
 */
export function isCodexUsageLimitError(error: unknown): boolean {
    if (!isRecord(error)) return false;
    const info = error.codexErrorInfo;
    const name = isRecord(info) ? Object.keys(info)[0] : stringField(info);
    return name === 'usageLimitExceeded';
}

/**
 * How long the continuation waits for `account/rateLimits/read` before it gives up and continues: the read asks Codex's
 * backend, and an unanswered read must not hold the turn the user was promised.
 */
const RATE_LIMITS_READ_TIMEOUT_MS = 10_000;

type CodexRequest = (method: string, parameters: Json, timeoutMs?: number) => Promise<unknown>;

/**
 * The general limit's entry in an `account/rateLimits/read` answer: the multi-bucket view's `codex`, or the
 * single-bucket `rateLimits` when that is the general limit.
 */
function generalLimits(result: unknown): Json | undefined {
    if (!isRecord(result)) return undefined;
    const byLimitId = isRecord(result.rateLimitsByLimitId) ? result.rateLimitsByLimitId : {};
    const general = byLimitId[CODEX_GENERAL_LIMIT_ID];
    if (isRecord(general)) return general;
    const single = isRecord(result.rateLimits) ? result.rateLimits : undefined;
    const limitId = stringField(single?.limitId) ?? CODEX_GENERAL_LIMIT_ID;
    return limitId === CODEX_GENERAL_LIMIT_ID ? single : undefined;
}

/**
 * The general limit's windows from Codex's `account/rateLimits/updated`, which the error that fails a turn does not
 * repeat: they tell which window is used up and when it resets. Codex rounds these percentages to whole numbers, so
 * they only ever say "used up" here; the weekly usage guard reads the unrounded figures from the rollout instead.
 */
export class CodexUsageLimits {
    private windows: CodexWindowReading[] = [];

    /**
     * Takes `account/rateLimits/updated`, one sparse update: a window the update leaves out keeps its last reading.
     */
    onNotification(method: string, parameters: Json): boolean {
        if (method !== 'account/rateLimits/updated') return false;
        const limits = isRecord(parameters.rateLimits) ? parameters.rateLimits : undefined;
        const limitId = stringField(limits?.limitId);
        if (!limits || (limitId && limitId !== CODEX_GENERAL_LIMIT_ID)) return true;
        for (const candidate of [limits.primary, limits.secondary]) {
            if (!isRecord(candidate) || typeof candidate.usedPercent !== 'number') continue;
            const window = codexWindow(candidate.windowDurationMins);
            const resetsAt =
                typeof candidate.resetsAt === 'number' && candidate.resetsAt > 0
                    ? Math.round(candidate.resetsAt * 1000)
                    : undefined;
            this.windows = [
                ...this.windows.filter((existing) => existing.window !== window),
                {
                    window,
                    usedPercent: candidate.usedPercent,
                    ...(resetsAt !== undefined && { resetsAt }),
                },
            ];
        }
        return true;
    }

    /**
     * Asks Codex for the general limit's windows now (`account/rateLimits/read`, verified against the codex-cli 0.165
     * app-server schema) and keeps them as the latest reading. Read right before an automatic continuation, so a reset
     * Codex reported early moves the wait instead of failing a turn into a window that is still used up. Undefined when
     * the answer names no general limit.
     */
    async read(
        request: CodexRequest,
        now: number = Date.now(),
    ): Promise<Omit<UsageLimit, 'provider'> | undefined> {
        const limits = generalLimits(
            await request(
                'account/rateLimits/read',
                { excludeResetCreditDetails: true },
                RATE_LIMITS_READ_TIMEOUT_MS,
            ),
        );
        if (!limits) return undefined;
        this.onNotification('account/rateLimits/updated', { rateLimits: limits });
        const windows: UsageLimit['windows'] = [];
        for (const candidate of [limits.primary, limits.secondary]) {
            if (!isRecord(candidate) || typeof candidate.usedPercent !== 'number') continue;
            const minutes = candidate.windowDurationMins;
            const scope = codexWindow(minutes);
            windows.push({
                windowMinutes: typeof minutes === 'number' && minutes > 0 ? Math.round(minutes) : 0,
                usedPercent: Math.min(100, Math.max(0, candidate.usedPercent)),
                ...(typeof candidate.resetsAt === 'number' &&
                    candidate.resetsAt > 0 && { resetsAt: Math.round(candidate.resetsAt * 1000) }),
                ...(scope !== 'unknown' && { scope }),
            });
        }
        const planType = stringField(limits.planType)?.slice(0, 64);
        return { observedAt: now, ...(planType && { planType }), windows };
    }

    /**
     * The used-up limit an `error` notification reports, or undefined for any other error and for one Codex retries.
     */
    errorLimit(parameters: Json): AgentChatUsageLimit | undefined {
        if (parameters.willRetry === true || !isCodexUsageLimitError(parameters.error))
            return undefined;
        return this.usageLimit();
    }

    /**
     * The limit a usage-limit failure ran into: a used-up weekly window before a used-up 5-hour one, since it resets
     * last, or an unattributed limit when no reading says which.
     */
    usageLimit(now: number = Date.now()): AgentChatUsageLimit {
        const usedUp = this.windows.filter(
            (reading) =>
                reading.usedPercent >= 100 &&
                (reading.resetsAt === undefined || reading.resetsAt > now),
        );
        const reading = usedUp.find((entry) => entry.window === 'weekly') ?? usedUp.at(0);
        if (!reading) return { window: 'unknown' };
        return {
            window: reading.window,
            ...(reading.resetsAt !== undefined && { resetsAt: reading.resetsAt }),
        };
    }
}

/**
 * The lifecycle failure of a failed turn: `billing_error` (the lifecycle's quota failure, as for a Claude Chat) when
 * its error notice carries a used-up plan limit.
 */
export function codexTurnFailure(
    snapshot: AgentChatSnapshot,
    turnId: string,
): 'billing_error' | 'provider_failed' {
    const notice = snapshot.items.find((item) => item.id === `${turnId}:error`);
    return notice?.type === 'notice' && notice.usageLimit ? 'billing_error' : 'provider_failed';
}
