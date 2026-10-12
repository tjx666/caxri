import type { AgentUsageReadout, UsageLimit } from '@caxri/protocol';
import { formatTokens, formatUsd } from '@caxri/protocol';

import { LIMIT_WARNING_PERCENT } from '../usage/usage-presentation';

type LimitWindow = UsageLimit['windows'][number];

/**
 * Compact window name for the chip: `5h`, `7d`, `90m`.
 */
export function shortWindowName(minutes: number): string {
    if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
}

/**
 * Rate-limit windows that have not reset since the conversation recorded them, shortest first. A window whose reset
 * time has passed reports usage that no longer applies, so it is dropped rather than shown stale.
 */
export function currentLimitWindows(limit: UsageLimit | undefined, now: number): LimitWindow[] {
    if (!limit) return [];
    return limit.windows
        .filter((window) => window.resetsAt === undefined || window.resetsAt > now)
        .toSorted((a, b) => a.windowMinutes - b.windowMinutes);
}

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
 * The chip text: conversation tokens, estimated cost, and the shortest live rate-limit window, e.g. `1.2M · $3.40 · 5h
 * 62%`. Cost follows {@link agentUsageCostLabel}. The limit is the newest account-wide reading the Server has seen,
 * which may come from another conversation, so the hover card states its age.
 */
export function agentUsageLabel(readout: AgentUsageReadout, now: number): string {
    const parts = [formatTokens(readout.tokens.total)];
    const cost = agentUsageCostLabel(readout);
    if (cost) parts.push(cost);
    const window = currentLimitWindows(readout.limit, now).at(0);
    if (window)
        parts.push(`${shortWindowName(window.windowMinutes)} ${Math.round(window.usedPercent)}%`);
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
 * The tone of the limit window the chip shows (the shortest live one), or undefined below the warning threshold or
 * without a live window. It follows the displayed figure so the colour never disagrees with the number beside it.
 */
export function agentUsageLimitTone(
    readout: AgentUsageReadout,
    now: number,
): AgentUsageLimitTone | undefined {
    const window = currentLimitWindows(readout.limit, now).at(0);
    if (!window) return undefined;
    const used = Math.round(window.usedPercent);
    return used >= LIMIT_WARNING_PERCENT ? 'warning' : undefined;
}
