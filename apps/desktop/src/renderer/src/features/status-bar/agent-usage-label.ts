import type { AgentUsageReadout, UsageLimit } from '@caxri/protocol';
import {
    currentLimitWindows,
    formatTokens,
    formatUsd,
    limitPaceShortfall,
    remainingLimitPercent,
    shortLimitWindowName,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { localizedLimitReset, localizedLimitWindowName } from '../../lib/usage-format';
import { LIMIT_WARNING_PERCENT } from '../usage/usage-presentation';

/**
 * How the conversation's estimated cost reads: undefined while every model is unpriced (`$0.00` would read as free),
 * and `≥$3.40` while only some are, since the figure then leaves the unpriced models' usage out and is a lower bound.
 * The Usage page marks the same case with a muted `partial` beside the figure; the chip has no room for a word.
 */
export function agentUsageCostLabel(readout: AgentUsageReadout): string | undefined {
    if (readout.unpricedModels.length >= readout.models.length) return undefined;
    const cost = formatUsd(readout.costUsd);
    return readout.unpricedModels.length > 0 ? `≥${cost}` : cost;
}

/**
 * The 5-hour plan window, which the chip leaves out unless `statusBar.usage.showFiveHourLimit` is on.
 */
const FIVE_HOUR_WINDOW_MINUTES = 300;

/**
 * What the chip reads from its Setting; the hover card ignores it and always lists every window.
 */
export interface AgentUsageChipOptions {
    /**
     * `statusBar.usage.showFiveHourLimit`: the 5-hour window resets several times a day, so it is opt-in.
     */
    showFiveHourLimit: boolean;
}

/**
 * The live limit windows the chip itself shows: {@link currentLimitWindows} minus the 5-hour window unless the user
 * opted in. The weekly window is the one that actually stops a plan for days, so it is the one worth a status-bar
 * slot.
 */
function agentUsageChipWindows(
    limit: UsageLimit | undefined,
    now: number,
    { showFiveHourLimit }: AgentUsageChipOptions,
): ReturnType<typeof currentLimitWindows> {
    const windows = currentLimitWindows(limit, now);
    return showFiveHourLimit
        ? windows
        : windows.filter((window) => window.windowMinutes !== FIVE_HOUR_WINDOW_MINUTES);
}

/**
 * The chip text: conversation tokens, estimated cost, and every live rate-limit window shortest first, e.g. `1.2M ·
 * $3.40 · 5h 38% left · 7d 88% left` (windows per {@link agentUsageChipWindows}), so the 5-hour and weekly plan limits
 * read apart and never as context or token use. Cost follows {@link agentUsageCostLabel}. The limit is the newest
 * account-wide reading the Server has seen, which may come from another conversation, so the hover card states its age
 * and each window's reset.
 */
export function agentUsageLabel(
    readout: AgentUsageReadout,
    now: number,
    options: AgentUsageChipOptions,
    t: Translate = translate,
): string {
    const parts = [formatTokens(readout.tokens.total)];
    const cost = agentUsageCostLabel(readout);
    if (cost) parts.push(cost);
    const windows = agentUsageChipWindows(readout.limit, now, options);
    if (windows.length > 0)
        parts.push(
            windows
                .map((window) =>
                    t('statusBar.usage.chipLimitWindow', {
                        window: shortLimitWindowName(window.windowMinutes),
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
 * window is projected to run out before it resets (`limitPaceShortfall`, the same function the Chat composer's pace row
 * uses). Both follow the displayed figures, so the colour never disagrees with a number beside it: a nearly spent
 * weekly limit warns even while the 5-hour window has room, and a weekly limit at 70% left with 6 of 7 days to go warns
 * before it is nearly spent, when slowing down still helps. The first tenth of a window never warns on pace.
 */
export function agentUsageLimitTone(
    readout: AgentUsageReadout,
    now: number,
    options: AgentUsageChipOptions,
): AgentUsageLimitTone | undefined {
    const isNearlySpent = agentUsageChipWindows(readout.limit, now, options).some(
        (window) => Math.round(window.usedPercent) >= LIMIT_WARNING_PERCENT,
    );
    return isNearlySpent || limitPaceShortfall(readout.limit, now) !== undefined
        ? 'warning'
        : undefined;
}

/**
 * The tooltip sentence that says why the chip warns when the cause is pace rather than a nearly spent window, e.g.
 * `Weekly limit: 70% left, resets in 6d 14h. At this rate it runs out before it resets; ...`. The note says the warning
 * is a projection and clears as usage slows or the window's clock catches up. Undefined while every window is on pace.
 */
export function agentUsagePaceNote(
    readout: AgentUsageReadout,
    now: number,
    t: Translate = translate,
): string | undefined {
    const shortfall = limitPaceShortfall(readout.limit, now);
    if (!shortfall) return undefined;
    const { window } = shortfall;
    return t('statusBar.usage.paceNote', {
        window: localizedLimitWindowName(window.windowMinutes, t),
        percent: remainingLimitPercent(window.usedPercent),
        reset: localizedLimitReset(window.resetsAt, now, t),
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
    t: Translate = translate,
): string {
    return currentLimitWindows(limit, now)
        .map((window) =>
            window.resetsAt === undefined
                ? `${window.windowMinutes}`
                : `${window.windowMinutes}:${localizedLimitReset(window.resetsAt, now, t)}`,
        )
        .join('|');
}
