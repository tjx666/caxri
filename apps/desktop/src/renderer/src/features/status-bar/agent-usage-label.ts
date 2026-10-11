import type { AgentUsageReadout, UsageLimit } from '@caxri/protocol';
import { formatTokens, formatUsd } from '@caxri/protocol';

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
 * The chip text: conversation tokens, estimated cost, and the shortest live rate-limit window, e.g. `1.2M · $3.40 · 5h
 * 62%`. Cost is left out while every model is unpriced, since `$0.00` would read as free.
 */
export function agentUsageLabel(readout: AgentUsageReadout, now: number): string {
    const parts = [formatTokens(readout.tokens.total)];
    if (readout.unpricedModels.length < readout.models.length)
        parts.push(formatUsd(readout.costUsd));
    const window = currentLimitWindows(readout.limit, now).at(0);
    if (window)
        parts.push(`${shortWindowName(window.windowMinutes)} ${Math.round(window.usedPercent)}%`);
    return parts.join(' · ');
}
