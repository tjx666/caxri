import type { AgentChatCommand, AgentChatSnapshot, AgentChatUsage } from '@caxri/protocol';
import { formatTokens, formatUsd } from '@caxri/protocol';

import { translate } from '../../i18n';
import { localizedDuration } from '../../lib/usage-format';

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
 * How long before the prompt cache expires the composer starts counting down, so the user can still reply (or compact)
 * while the context is cached instead of learning about the expiry after it already cost a full re-read. A short cache
 * (Claude's 5m default) warns for its second half only, or the notice would appear the moment a reply lands.
 */
const CACHE_EXPIRY_LEAD_MS = 10 * 60_000;

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
 * The composer's notices about the context of an idle Chat: the prompt cache is about to expire or has expired, so the
 * next message pays (or soon will pay) to write the whole context again; and the context is high enough that compacting
 * it first is worth suggesting.
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

interface AgentChatCacheAlert extends AgentChatContextAlert {
    /**
     * `expiring` while the cache is still warm but within the warning lead of its TTL; `expired` once it is gone.
     */
    state: 'expiring' | 'expired';
}

export interface AgentChatContextAlerts {
    cache?: AgentChatCacheAlert;
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
        const ttlMs = cacheTtlMinutes * 60_000;
        const cost =
            usage.cacheRewriteUsd === undefined
                ? ''
                : translate('agentChat.context.cacheCost', {
                      cost: formatUsd(usage.cacheRewriteUsd),
                  });
        const costNote = cost && translate('agentChat.context.cacheDetailCost');
        if (idleMs >= ttlMs) {
            alerts.cache = {
                state: 'expired',
                text: translate('agentChat.context.cacheText', {
                    duration: localizedDuration(idleMs),
                    cost,
                }),
                detail: `${translate('agentChat.context.cacheDetail', { minutes: cacheTtlMinutes, tokens })}${costNote}`,
            };
        } else if (idleMs >= ttlMs - Math.min(CACHE_EXPIRY_LEAD_MS, ttlMs / 2)) {
            // Rounded up so the countdown never claims `0m` while the cache is still warm.
            const remaining = localizedDuration(Math.ceil((ttlMs - idleMs) / 60_000) * 60_000);
            alerts.cache = {
                state: 'expiring',
                text: translate('agentChat.context.cacheExpiringText', { remaining, cost }),
                detail: `${translate('agentChat.context.cacheExpiringDetail', { minutes: cacheTtlMinutes, remaining, tokens })}${costNote}`,
            };
        }
    }
    const window = usage.compactWindow ?? usage.contextWindow;
    if (window && usage.totalTokens / window >= HIGH_CONTEXT_SHARE)
        alerts.pressure = {
            text: translate('agentChat.context.pressureText', {
                tokens,
                window: formatTokens(window),
            }),
            detail: translate('agentChat.context.pressureDetail', {
                percent: Math.round((usage.totalTokens / window) * 100),
            }),
        };
    return alerts;
}

/**
 * What the context row's live region says: one fixed phrase per notice state, never the countdown or the idle time. The
 * visible row ticks every minute, and a live region holding it would announce each tick; this text changes only when a
 * notice appears, the cache goes from expiring to expired, or a notice goes away.
 */
export function agentChatContextAnnouncement(alerts: AgentChatContextAlerts): string {
    const parts: string[] = [];
    if (alerts.cache)
        parts.push(
            translate(
                alerts.cache.state === 'expired'
                    ? 'agentChat.context.cacheExpiredAnnouncement'
                    : 'agentChat.context.cacheExpiringAnnouncement',
            ),
        );
    if (alerts.pressure) parts.push(translate('agentChat.context.pressureAnnouncement'));
    return parts.join('. ');
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
