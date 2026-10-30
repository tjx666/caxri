import type {
    AgentChatTurnMetrics,
    AgentChatTurnUsage,
    AgentThroughputSpeed,
} from '@caxri/protocol';
import { formatTokens, formatUsd, tokenCountParts } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react';
import { Gauge, Rabbit, Turtle } from 'lucide-react';

import type { Translate } from '../../../i18n';
import {
    describeThroughputAggregate,
    formatThroughputRate,
    throughputRate,
    throughputSpeedLabel,
} from '../../status-bar/agent-throughput-label';

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

/**
 * The glyph beside a finished turn's rate, by the speed tier its responses ran at rather than by a threshold on the
 * figure: the same model reads faster or slower with its load, while the tier is what the user chose. A turn whose tier
 * was not recorded gets the status bar's Gauge.
 */
export const AGENT_CHAT_SPEED_ICONS: Record<AgentThroughputSpeed | 'unknown', LucideIcon> = {
    fast: Rabbit,
    standard: Gauge,
    flex: Turtle,
    unknown: Gauge,
};

export interface AgentChatTurnRate {
    /**
     * `62 tok/s`.
     */
    value: string;
    speed: AgentThroughputSpeed | undefined;
    /**
     * `Fast · 3,210 tokens in 52s · 62 tok/s`, without the tier when the transcript recorded none.
     */
    tooltip: string;
}

/**
 * A finished turn's output rate for the end of its fold row, or `undefined` when the turn recorded no timing or ran too
 * briefly to rate (below the throughput floor).
 */
export function agentChatTurnRate(
    metrics: AgentChatTurnMetrics | undefined,
    t: Translate,
): AgentChatTurnRate | undefined {
    if (metrics?.outputTokens === undefined || metrics.generationMs === undefined) return undefined;
    const generated = {
        outputTokens: metrics.outputTokens,
        durationMs: metrics.generationMs,
        responseCount: 1,
    };
    const rate = throughputRate(generated);
    if (rate === undefined) return undefined;
    const details = describeThroughputAggregate(generated, t);
    return {
        value: formatThroughputRate(rate, t.locale),
        speed: metrics.speed,
        tooltip: metrics.speed ? `${throughputSpeedLabel(metrics.speed, t)} · ${details}` : details,
    };
}

/**
 * What the reply footer of a finished turn with no fold row reads after its time, the way LobeHub's message footer
 * does: the speed (`62 tok/s`, behind the glyph of the tier it ran at), then the cost as a bare figure (`0.42`) the
 * footer puts behind the same dollar glyph the composer's metric strip uses, with the measured totals and the estimate
 * caveat as tooltip lines. Undefined when the turn recorded neither a rate nor a cost; a turn too short to rate (below
 * the throughput floor) or whose models have no price shows the other figure alone.
 */
export function agentChatReplyMetrics(
    metrics: AgentChatTurnMetrics | undefined,
    t: Translate,
): { cost?: string; details: string[]; rate?: string; speed?: AgentThroughputSpeed } | undefined {
    if (!metrics) return undefined;
    const rate = agentChatTurnRate(metrics, t);
    const costUsd =
        metrics.costUsd !== undefined && metrics.costUsd > 0 ? metrics.costUsd : undefined;
    if (!rate && costUsd === undefined) return undefined;
    const details = [
        rate?.tooltip,
        costUsd === undefined
            ? undefined
            : t('agentChat.message.turnCost', { cost: formatUsd(costUsd) }),
    ].filter((line) => line !== undefined);
    return {
        cost: costUsd === undefined ? undefined : formatAgentChatTurnCost(costUsd),
        details,
        rate: rate?.value,
        ...(rate?.speed && { speed: rate.speed }),
    };
}
