import type { AgentChatTurnUsage } from '@caxri/protocol';
import { formatTokens, tokenCountParts } from '@caxri/protocol';

export type AgentChatTurnMetricKind = 'steps' | 'tokens' | 'cost';

export interface AgentChatTurnMetric {
    kind: AgentChatTurnMetricKind;
    /**
     * The figure as text, for the tooltip and for tests: the animated figure's shadow root holds every digit.
     */
    value: string;
    /**
     * The same figure as the strip animates it: the number, its exact fraction digits, and a unit suffix.
     */
    figure: { value: number; fractionDigits: number; suffix: string };
}

/**
 * Fraction digits of the cost beside a dollar icon: four below a cent, so the first responses of a turn still read as
 * something, then two.
 */
function costFractionDigits(usd: number): number {
    return usd < 0.01 ? 4 : 2;
}

/**
 * The cost figure beside a dollar icon, so without a `$`, in {@link costFractionDigits}.
 */
export function formatAgentChatTurnCost(usd: number): string {
    return usd.toFixed(costFractionDigits(usd));
}

/**
 * The running turn's figures the composer strip shows, in order: steps, tokens, cost. A figure that is still zero is
 * left out, and a single step is too, since every turn makes at least one model request.
 */
export function agentChatTurnMetrics(
    usage: Pick<AgentChatTurnUsage, 'requests' | 'totalTokens' | 'costUsd'> | undefined,
): AgentChatTurnMetric[] {
    if (!usage) return [];
    const metrics: AgentChatTurnMetric[] = [];
    if (usage.requests > 1)
        metrics.push({
            kind: 'steps',
            value: String(usage.requests),
            figure: { value: usage.requests, fractionDigits: 0, suffix: '' },
        });
    if (usage.totalTokens > 0) {
        const { value, suffix } = tokenCountParts(usage.totalTokens);
        metrics.push({
            kind: 'tokens',
            value: formatTokens(usage.totalTokens),
            figure: { value, fractionDigits: Number.isSafeInteger(value) ? 0 : 1, suffix },
        });
    }
    if (usage.costUsd !== undefined && usage.costUsd > 0) {
        const value = formatAgentChatTurnCost(usage.costUsd);
        // Round through the text so the animated figure never disagrees with `toFixed` on a half-cent.
        const figure = {
            value: Number(value),
            fractionDigits: costFractionDigits(usage.costUsd),
            suffix: '',
        };
        metrics.push({ kind: 'cost', value, figure });
    }
    return metrics;
}
