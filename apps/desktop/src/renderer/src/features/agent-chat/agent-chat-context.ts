import type { AgentChatSnapshot, AgentChatUsage } from '@caxri/protocol';
import { formatDuration, formatTokens, formatUsd } from '@caxri/protocol';

/**
 * Share of the compaction window past which the context counts as high: the meter turns `--danger` and the composer
 * suggests compacting. Claude Code's quality degrades well before it compacts on its own, so the warning comes early.
 */
const HIGH_CONTEXT_SHARE = 0.7;

/**
 * Share past which the meter turns `--warning`, so the step to `--danger` is not the first change the user sees.
 */
const ELEVATED_CONTEXT_SHARE = 0.5;

/**
 * How full the context window is, for the composer's meter. Omitted until the provider reports a window size.
 */
export interface AgentChatContextUsage {
    /**
     * Share of {@link window} in use, from 0 to 1.
     */
    used: number;
    totalTokens: number;
    /**
     * The window pressure is measured against: the provider's compaction window when it is smaller than the model's.
     */
    window: number;
    /**
     * The model's own window, when the compaction window is smaller than it.
     */
    modelWindow?: number;
    tone: 'normal' | 'warning' | 'danger';
    breakdown: NonNullable<AgentChatUsage['breakdown']>;
}

export function agentChatContextUsage(
    snapshot: Pick<AgentChatSnapshot, 'usage'> | undefined,
): AgentChatContextUsage | undefined {
    const usage = snapshot?.usage;
    const window = usage?.compactWindow ?? usage?.contextWindow;
    if (!usage || !window) return undefined;
    const share = usage.totalTokens / window;
    return {
        used: Math.min(share, 1),
        totalTokens: usage.totalTokens,
        window,
        ...(usage.compactWindow &&
            usage.contextWindow &&
            usage.contextWindow > usage.compactWindow && { modelWindow: usage.contextWindow }),
        tone:
            share >= HIGH_CONTEXT_SHARE
                ? 'danger'
                : share >= ELEVATED_CONTEXT_SHARE
                  ? 'warning'
                  : 'normal',
        breakdown: usage.breakdown ?? [],
    };
}

/**
 * The composer's notices about the context of an idle Chat: the prompt cache has expired, so the next message pays to
 * write the whole context again; and the context is high enough that compacting it first is worth suggesting.
 */
export interface AgentChatContextAlert {
    /**
     * The short line the composer shows; it has to survive a narrow pane.
     */
    text: string;
    /**
     * The numbers behind it, for the hover title.
     */
    detail: string;
}

export interface AgentChatContextAlerts {
    cache?: AgentChatContextAlert;
    pressure?: AgentChatContextAlert;
}

export function agentChatContextAlerts(
    usage: AgentChatUsage | undefined,
    now: number,
): AgentChatContextAlerts {
    if (!usage || usage.totalTokens <= 0) return {};
    const alerts: AgentChatContextAlerts = {};
    const { cacheTtlMinutes, lastResponseAt } = usage;
    const tokens = formatTokens(usage.totalTokens);
    if (cacheTtlMinutes && lastResponseAt !== undefined) {
        const idleMs = now - lastResponseAt;
        if (idleMs >= cacheTtlMinutes * 60_000) {
            const cost =
                usage.cacheRewriteUsd === undefined
                    ? ''
                    : ` (~${formatUsd(usage.cacheRewriteUsd)})`;
            alerts.cache = {
                text: `Cache expired · next message rewrites ${tokens} tokens${cost}`,
                detail: `Idle ${formatDuration(idleMs)}, past the ${cacheTtlMinutes}m prompt cache lifetime.${cost && ' The cost is an estimate at standard API prices.'}`,
            };
        }
    }
    const window = usage.compactWindow ?? usage.contextWindow;
    if (window && usage.totalTokens / window >= HIGH_CONTEXT_SHARE)
        alerts.pressure = {
            text: `Context ${tokens} / ${formatTokens(window)} · consider /compact`,
            detail: `The conversation fills ${Math.round((usage.totalTokens / window) * 100)}% of the window the Agent compacts at. Compacting now keeps answers sharp.`,
        };
    return alerts;
}
