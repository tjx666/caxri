import type { AgentUsageReadout, AppSettings, UsageDay, UsageLimit } from '@caxri/protocol';
import {
    agentUsageCostLabel,
    currentLimitWindows,
    currentResetCredits,
    formatPlanName,
    formatTokens,
    isResetCreditExpiringSoon,
    LIMIT_WARNING_PERCENT,
    limitPaceShortfall,
    remainingLimitPercent,
    shiftLocalDate,
} from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import { formatCount } from '../../lib/locale-format';
import {
    limitWindowKey,
    localizedLimitReset,
    localizedLimitWindowLabel,
    localizedResetCreditExpiry,
    localizedShortLimitWindowLabel,
} from '../../lib/usage-format';

/**
 * The 5-hour plan window, which the chip shows for plans it constrains (see {@link isFiveHourBoundPlan}).
 */
const FIVE_HOUR_WINDOW_MINUTES = 300;

/**
 * What the chip reads from its Setting; the hover card ignores it and always lists every window.
 */
export interface AgentUsageChipOptions {
    /**
     * `statusBar.usage.limitWindows`: which plan windows the chip shows. `auto` picks by plan.
     */
    limitWindows: AppSettings['statusBar.usage.limitWindows'];
}

/**
 * Whether the 5-hour window is the one that stops this plan in practice: Claude Pro and Max 5x run out of it most days
 * long before their weekly window, while Max 20x, Team, Enterprise, and Codex plans are bound by the week. Claude
 * Code's `planType` says only `max`, so Max 5x is told apart by its rate-limit tier (`default_claude_max_5x`).
 */
function isFiveHourBoundPlan(limit: UsageLimit | undefined): boolean {
    if (limit?.provider !== 'claude') return false;
    if (limit.planType === 'pro') return true;
    return limit.planType === 'max' && (limit.rateLimitTier?.endsWith('_max_5x') ?? false);
}

/**
 * Whether a window is at or past the share where the Usage page's limit bars turn to warning.
 */
function isNearlySpentWindow(window: { usedPercent: number }): boolean {
    return Math.round(window.usedPercent) >= LIMIT_WARNING_PERCENT;
}

/**
 * The windows that apply to the conversation's models. A provider whose models share quota per group (Antigravity's
 * `Gemini` and `Claude & GPT`) reports each group's windows; the chip keeps only the groups whose name matches a model
 * the conversation used, by word (`claude-sonnet-4-6` matches `Claude & GPT`). Windows without a group always apply,
 * and when no group matches (no model yet, or an unknown name) every window is kept.
 */
export function windowsForModels<T extends { group?: string | undefined }>(
    windows: readonly T[],
    models: readonly string[],
): T[] {
    if (windows.every((window) => !window.group)) return [...windows];
    const modelText = models.join(' ').toLowerCase();
    const matches = (group: string) =>
        group
            .toLowerCase()
            .split(/[^a-z\d]+/u)
            .some((word) => word.length > 1 && modelText.includes(word));
    const kept = windows.filter((window) => !window.group || matches(window.group));
    return kept.some((window) => window.group) ? kept : [...windows];
}

/**
 * The most windows the chip text names. A provider that reports a window per model group (Antigravity) falls back to
 * showing every group when no group matches the conversation's models, which made the chip as long as the account; the
 * hover card still lists every window.
 */
const MAX_CHIP_WINDOWS = 2;

/**
 * The live limit windows the chip itself shows, at most {@link MAX_CHIP_WINDOWS} and the most constrained
 * ones:{@link currentLimitWindows} filtered by the Setting. `auto` shows the 5-hour window for
 * {@link isFiveHourBoundPlan} plans and every other window otherwise, and falls back to every live window when its pick
 * has none, so a reading without a 5-hour window still shows its weekly one. In `auto`, a live window at or over the
 * warning threshold is added to the pick, so the chip text never hides the reason it warns.
 */
function agentUsageChipWindows(
    limit: UsageLimit | undefined,
    now: number,
    options: AgentUsageChipOptions,
    models: readonly string[] = [],
): ReturnType<typeof currentLimitWindows> {
    return mostConstrainedWindows(pickChipWindows(limit, now, options, models), MAX_CHIP_WINDOWS);
}

/**
 * At most `max` windows, the ones with the least left (highest used share, so a nearly spent or warning window always
 * survives), kept in their original display order. Ties keep the earlier window.
 */
export function mostConstrainedWindows<T extends { usedPercent: number }>(
    windows: readonly T[],
    max: number,
): T[] {
    if (windows.length <= max) return [...windows];
    const keep = new Set(
        windows
            .map((window, index) => ({ window, index }))
            .toSorted((a, b) => b.window.usedPercent - a.window.usedPercent || a.index - b.index)
            .slice(0, max)
            .map((entry) => entry.window),
    );
    return windows.filter((window) => keep.has(window));
}

function pickChipWindows(
    limit: UsageLimit | undefined,
    now: number,
    { limitWindows }: AgentUsageChipOptions,
    models: readonly string[],
): ReturnType<typeof currentLimitWindows> {
    const windows = windowsForModels(currentLimitWindows(limit, now), models);
    const isFiveHour = (window: (typeof windows)[number]) =>
        window.windowMinutes === FIVE_HOUR_WINDOW_MINUTES;
    switch (limitWindows) {
        case 'both':
            return windows;
        case 'fiveHour':
            return windows.filter(isFiveHour);
        case 'weekly':
            return windows.filter((window) => !isFiveHour(window));
        case 'auto': {
            const isFiveHourBound = isFiveHourBoundPlan(limit);
            const isPicked = (window: (typeof windows)[number]) =>
                isFiveHour(window) === isFiveHourBound;
            if (!windows.some(isPicked)) return windows;
            // A nearly spent window the pick left out is promoted into the chip so its colour and its text agree: a
            // Pro or Max 5x chip showing only `5h` must not stay silent while the week is almost gone.
            return windows.filter((window) => isPicked(window) || isNearlySpentWindow(window));
        }
    }
}

/**
 * The chip text: conversation tokens, estimated cost, and every live rate-limit window shortest first, e.g. `1.2M ·
 * $3.40 · 5h 38% left · wk 88% left` (windows per {@link agentUsageChipWindows}), so the 5-hour and weekly plan limits
 * read apart and never as context or token use. Cost follows {@link agentUsageCostLabel}. The limit is the newest
 * account-wide reading the Server has seen, which may come from another conversation, so the hover card states its age
 * and each window's reset.
 */
export function agentUsageLabel(
    readout: AgentUsageReadout,
    now: number,
    options: AgentUsageChipOptions,
    t: Translate,
): string {
    const parts = [formatTokens(readout.tokens.total)];
    const cost = agentUsageCostLabel(readout);
    if (cost) parts.push(cost);
    const windows = agentUsageChipWindows(readout.limit, now, options, readout.models);
    if (windows.length > 0)
        parts.push(
            windows
                .map((window) =>
                    t('statusBar.usage.chipLimitWindow', {
                        window: localizedShortLimitWindowLabel(window, t),
                        percent: remainingLimitPercent(window.usedPercent),
                    }),
                )
                .join(' · '),
        );
    return parts.join(' · ');
}

/**
 * The chip's limit readout turns `--warning` at the same share the Usage page's limit bars do
 * (`LIMIT_WARNING_PERCENT`), so the status bar and the page never disagree about one window. Unlike the output-speed
 * gauge, which DESIGN.md keeps threshold-free because "slow" is the reader's call, a rate limit is a hard stop, so
 * approaching it earns a colour; it stays a warning rather than `--danger` because nothing has failed yet.
 */
export type AgentUsageLimitTone = 'warning';

/**
 * Warning while any live window the chip shows is at or past the warning threshold, or while the plan's multi-day
 * window the chip shows is projected to run out before it resets (`limitPaceShortfall`, the same function the Chat
 * composer's pace row uses). Both follow the displayed figures, so the colour never disagrees with a number beside it:
 * a nearly spent weekly limit warns even while the 5-hour window has room, and a weekly limit at 70% left with 6 of 7
 * days to go warns before it is nearly spent, when slowing down still helps. The first tenth of a window never warns on
 * pace.
 *
 * `isPaceDismissed` is the Chat pace reminder's dismissal for today: once the user has acknowledged the pace warning
 * the chip stops repeating it in colour, but a nearly spent window still warns because that is a harder stop the
 * dismissed reminder never described.
 */
export function agentUsageLimitTone(
    readout: AgentUsageReadout,
    now: number,
    options: AgentUsageChipOptions,
    isPaceDismissed = false,
): AgentUsageLimitTone | undefined {
    const causes = agentUsageWarningCauses(readout, now, options, isPaceDismissed);
    return causes.length > 0 ? 'warning' : undefined;
}

/**
 * Why the chip warns, in display order. {@link agentUsageLimitTone} and {@link agentUsageWarningReason} share it so the
 * colour and the screen-reader text can never disagree.
 */
type AgentUsageWarningCause = 'nearlySpent' | 'pace' | 'creditExpiring';

function agentUsageWarningCauses(
    readout: AgentUsageReadout,
    now: number,
    options: AgentUsageChipOptions,
    isPaceDismissed: boolean,
): AgentUsageWarningCause[] {
    const windows = agentUsageChipWindows(readout.limit, now, options, readout.models);
    const causes: AgentUsageWarningCause[] = [];
    if (windows.some((window) => isNearlySpentWindow(window))) causes.push('nearlySpent');
    // Only a window the chip shows may colour it, so a 5-hour-only chip never warns about the week it does not show.
    const shortfall = isPaceDismissed ? undefined : limitPaceShortfall(readout.limit, now);
    if (
        shortfall !== undefined &&
        windows.some((window) => limitWindowKey(window) === limitWindowKey(shortfall.window))
    )
        causes.push('pace');
    // A banked reset that is about to expire is lost unless the user acts, so the chip asks for a glance.
    if (isResetCreditExpiringSoon(readout.limit, now)) causes.push('creditExpiring');
    return causes;
}

const WARNING_REASON_KEYS = {
    nearlySpent: 'statusBar.usage.warningReason.nearlySpent',
    pace: 'statusBar.usage.warningReason.pace',
    creditExpiring: 'statusBar.usage.warningReason.creditExpiring',
} as const satisfies Record<AgentUsageWarningCause, TranslationKey>;

/**
 * The plain-words reason the chip is coloured, for its accessible name, since the colour alone reaches no screen
 * reader. Undefined while the chip is not warning.
 */
export function agentUsageWarningReason(
    readout: AgentUsageReadout,
    now: number,
    options: AgentUsageChipOptions,
    t: Translate,
    isPaceDismissed = false,
): string | undefined {
    const causes = agentUsageWarningCauses(readout, now, options, isPaceDismissed);
    if (causes.length === 0) return undefined;
    return causes.map((cause) => t(WARNING_REASON_KEYS[cause])).join('; ');
}

/**
 * The tooltip sentence that says why the chip warns when the cause is pace rather than a nearly spent window, e.g.
 * `Weekly limit runs out before it resets at this rate.`. The window's row above it already shows what is left and when
 * it resets, so the note names only the projection. Undefined while every window is on pace.
 */
export function agentUsagePaceNote(
    readout: AgentUsageReadout,
    now: number,
    t: Translate,
): string | undefined {
    const shortfall = limitPaceShortfall(readout.limit, now);
    if (!shortfall) return undefined;
    return t('statusBar.usage.paceNote', {
        window: localizedLimitWindowLabel(shortfall.window, t),
    });
}

/**
 * The hover card's banked-reset row value, e.g. `2 · next expires in 3d 4h`; the count alone when no expiry is known.
 * Undefined while the account holds none.
 */
export function agentUsageResetCreditsValue(
    limit: UsageLimit | undefined,
    now: number,
    t: Translate,
): string | undefined {
    const credits = currentResetCredits(limit, now);
    if (!credits) return undefined;
    const count = formatCount(credits.availableCount, t.locale);
    if (credits.nextExpiresAt === undefined) return count;
    return t('statusBar.usage.resetCreditsValue', {
        count,
        expiry: localizedResetCreditExpiry(credits.nextExpiresAt, now, t),
    });
}

/**
 * The hover card's account rows, which follow the conversation's own rows: the subscription plan, each live limit
 * window with its reset, banked resets, and how old the reading is. Rows without a value are left out.
 */
export function agentUsageLimitRows(
    limit: UsageLimit | undefined,
    now: number,
    observedAgo: string | undefined,
    t: Translate,
): Array<{ label: string; value: string }> {
    const rows: Array<{ label: string; value: string }> = [];
    const plan = limit && formatPlanName(limit.provider, limit.planType, limit.rateLimitTier);
    if (plan) rows.push({ label: t('statusBar.usage.plan'), value: plan });
    const windows = currentLimitWindows(limit, now);
    for (const window of windows) {
        const left = t('statusBar.usage.limitLeft', {
            percent: remainingLimitPercent(window.usedPercent),
        });
        rows.push({
            label: t('statusBar.usage.limit', {
                window: localizedLimitWindowLabel(window, t),
            }),
            value:
                window.resetsAt === undefined
                    ? left
                    : `${left} · ${localizedLimitReset(window.resetsAt, now, t)}`,
        });
    }
    const resetCredits = agentUsageResetCreditsValue(limit, now, t);
    if (resetCredits) rows.push({ label: t('statusBar.usage.resetCredits'), value: resetCredits });
    if (observedAgo && windows.length > 0)
        rows.push({ label: t('statusBar.usage.limitsAsOf'), value: observedAgo });
    return rows;
}

/**
 * The tooltip sentence that says why the chip warns when a banked reset is about to expire. Undefined otherwise.
 */
export function agentUsageResetCreditsNote(
    limit: UsageLimit | undefined,
    now: number,
    t: Translate,
): string | undefined {
    const credits = currentResetCredits(limit, now);
    if (credits?.nextExpiresAt === undefined || !isResetCreditExpiringSoon(limit, now))
        return undefined;
    return t('statusBar.usage.resetCreditsExpiringNote', {
        expiry: localizedResetCreditExpiry(credits.nextExpiresAt, now, t),
    });
}

/**
 * Everything the usage chip and its Tooltip derive from the clock: which limit windows are still current and how each
 * one's reset reads. Two instants with the same signature render the same chip, so the chip's clock only advances when
 * this changes instead of on every poll or tick.
 */
export function agentUsageClockSignature(
    limit: UsageLimit | undefined,
    now: number,
    t: Translate,
): string {
    const windows = currentLimitWindows(limit, now)
        .map((window) =>
            window.resetsAt === undefined
                ? limitWindowKey(window)
                : `${limitWindowKey(window)}:${localizedLimitReset(window.resetsAt, now, t)}`,
        )
        .join('|');
    const credits = agentUsageResetCreditsValue(limit, now, t);
    return credits === undefined ? windows : `${windows}|${credits}`;
}

/**
 * Days the hover card charts the Agent's spend over, ending today.
 */
export const DAILY_COST_DAYS = 7;

/**
 * One charted day of an Agent's estimated spend.
 */
export interface DailyCost {
    /**
     * Local day, `YYYY-MM-DD`.
     */
    date: string;
    costUsd: number;
}

/**
 * The trailing {@link DAILY_COST_DAYS} local days ending `today`, oldest first. The report omits days without usage, so
 * they are filled in as zero to keep each bar on its own calendar day.
 */
export function dailyCostSeries(activity: readonly UsageDay[], today: string): DailyCost[] {
    const costByDate = new Map(activity.map((day) => [day.date, day.costUsd]));
    return Array.from({ length: DAILY_COST_DAYS }, (_, index) => {
        const date = shiftLocalDate(today, index - (DAILY_COST_DAYS - 1));
        return { date, costUsd: costByDate.get(date) ?? 0 };
    });
}
