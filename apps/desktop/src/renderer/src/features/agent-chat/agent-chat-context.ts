import type { AgentChatCommand, AgentChatSnapshot, AgentChatUsage } from '@caxri/protocol';
import { formatDuration, formatTokens, formatUsd } from '@caxri/protocol';

/**
 * Share of the compaction window past which the context counts as high: the meter turns `--danger` and the composer
 * suggests compacting. Set close to where the provider compacts on its own, so the suggestion arrives while compacting
 * by hand still saves a turn, without reading as a false alarm for most of a long conversation.
 */
const HIGH_CONTEXT_SHARE = 0.85;

/**
 * Share past which the meter turns `--warning`. Answer quality starts to degrade around here, and the step gives the
 * user a calm early signal so the change to `--danger` is not the first one they see.
 */
const ELEVATED_CONTEXT_SHARE = 0.6;

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
interface AgentChatContextAlert {
    /**
     * The short line the composer shows; it has to survive a narrow pane.
     */
    text: string;
    /**
     * The numbers behind it, for the hover tooltip.
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
                    : ` (est. ~${formatUsd(usage.cacheRewriteUsd)})`;
            alerts.cache = {
                text: `Idle ${formatDuration(idleMs)} · next reply re-reads the whole conversation${cost}`,
                detail: `The prompt cache lasts ${cacheTtlMinutes}m, so the next reply reads all ${tokens} tokens again without it.${cost && ' The cost is an estimate at standard API prices.'}`,
            };
        }
    }
    const window = usage.compactWindow ?? usage.contextWindow;
    if (window && usage.totalTokens / window >= HIGH_CONTEXT_SHARE)
        alerts.pressure = {
            text: `Context ${tokens} / ${formatTokens(window)} · consider compacting`,
            detail: `The conversation fills ${Math.round((usage.totalTokens / window) * 100)}% of the window the Agent compacts at. Compacting now keeps answers sharp.`,
        };
    return alerts;
}

/**
 * The provider command that compacts the conversation, when the provider reports one, so the context alert and the
 * meter's card can offer a Compact button that runs it the way typing `/compact` would.
 */
export function agentChatCompactCommand(
    commands: readonly AgentChatCommand[] | undefined,
): AgentChatCommand | undefined {
    return commands?.find((command) => command.name === 'compact');
}
