import type { AgentChatTurnUsage } from '@caxri/protocol';
import { formatTokens } from '@caxri/protocol';

export type AgentChatTurnMetricKind = 'steps' | 'tokens' | 'cost';

export interface AgentChatTurnMetric {
    kind: AgentChatTurnMetricKind;
    /**
     * The figure the strip shows next to the metric's icon.
     */
    value: string;
}

/**
 * The cost figure beside a dollar icon, so without a `$`: four decimals below a cent, so the first responses of a turn
 * still read as something, then two.
 */
export function formatAgentChatTurnCost(usd: number): string {
    return usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2);
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
    if (usage.requests > 1) metrics.push({ kind: 'steps', value: String(usage.requests) });
    if (usage.totalTokens > 0)
        metrics.push({ kind: 'tokens', value: formatTokens(usage.totalTokens) });
    if (usage.costUsd !== undefined && usage.costUsd > 0)
        metrics.push({ kind: 'cost', value: formatAgentChatTurnCost(usage.costUsd) });
    return metrics;
}
