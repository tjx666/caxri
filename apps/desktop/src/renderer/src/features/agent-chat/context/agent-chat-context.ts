import type { AgentChatCommand, AgentChatUsage } from '@caxri/protocol';
import {
    agentChatContextAlertsState,
    agentChatContextPercent,
    formatTokens,
    formatUsd,
} from '@caxri/protocol';

import type { Translate } from '../../../i18n';
import { localizedDuration } from '../../../lib/usage-format';

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
     * `expiring` while the cache is still warm but within the warning lead of its TTL; `compacting` in that same span
     * when idle compaction will compact the Chat before it expires; `expired` once it is gone.
     */
    state: 'compacting' | 'expiring' | 'expired';
}

export interface AgentChatContextAlerts {
    cache?: AgentChatCacheAlert;
    pressure?: AgentChatContextAlert;
}

/**
 * Words for the notices `agentChatContextAlertsState` (shared with Mobile) decides on. `idleCompactionAt` is when idle
 * compaction will compact this Chat (`agentChatIdleCompactionAt`), or `undefined` when it will not (the provider or
 * context does not qualify, or the setting is off).
 */
export function agentChatContextAlerts(
    usage: AgentChatUsage | undefined,
    now: number,
    idleCompactionAt: number | undefined,
    t: Translate,
): AgentChatContextAlerts {
    const state = agentChatContextAlertsState(usage, now, idleCompactionAt);
    if (!usage) return {};
    const alerts: AgentChatContextAlerts = {};
    const tokens = formatTokens(usage.totalTokens);
    const { cache, pressure } = state;
    if (cache) {
        const { cacheTtlMinutes: minutes, idleMs } = cache;
        const cost =
            usage.cacheRewriteUsd === undefined
                ? ''
                : t('agentChat.context.cacheCost', { cost: formatUsd(usage.cacheRewriteUsd) });
        const costNote = cost && t('agentChat.context.cacheDetailCost');
        const remaining = roundedUpDuration(cache.remainingMs ?? 0, t);
        if (cache.state === 'expired')
            alerts.cache = {
                state: 'expired',
                text: t('agentChat.context.cacheText', {
                    duration: localizedDuration(idleMs, t),
                    cost,
                }),
                detail: `${t('agentChat.context.cacheDetail', { minutes, tokens })}${costNote}`,
            };
        else if (cache.state === 'compacting')
            alerts.cache = {
                state: 'compacting',
                text: t('agentChat.context.cacheCompactingText', { remaining }),
                detail: `${t('agentChat.context.cacheCompactingDetail', { minutes, remaining, tokens })}${costNote}`,
            };
        else
            alerts.cache = {
                state: 'expiring',
                text: t('agentChat.context.cacheExpiringText', { remaining, cost }),
                detail: `${t('agentChat.context.cacheExpiringDetail', { minutes, remaining, tokens })}${costNote}`,
            };
    }
    if (pressure)
        alerts.pressure = {
            text: t('agentChat.context.pressureText', {
                tokens,
                window: formatTokens(pressure.limit),
            }),
            detail: t('agentChat.context.pressureDetail', {
                percent: agentChatContextPercent(usage.totalTokens, pressure.limit),
            }),
        };
    return alerts;
}

/**
 * A countdown rounded up to the minute, so it never claims `0m` while there is still time left.
 */
function roundedUpDuration(ms: number, t: Translate): string {
    return localizedDuration(Math.ceil(ms / 60_000) * 60_000, t);
}

/**
 * How the context row presents `alerts`: whether it shows at all (`isShown` is whether the strip has room), whether the
 * cache notice is the expired one, and whether it offers Compact. Compact appears for high context pressure and, as
 * "Compact now", while idle compaction counts down, so the user can run the same compaction without waiting; both need
 * the provider's compact command (`hasCompact`).
 */
export function agentChatContextRowState(
    alerts: AgentChatContextAlerts,
    isShown: boolean,
    hasCompact: boolean,
): { canCompact: boolean; isCompacting: boolean; isExpired: boolean; isVisible: boolean } {
    const isCompacting = alerts.cache?.state === 'compacting';
    return {
        canCompact: hasCompact && (alerts.pressure !== undefined || isCompacting),
        isCompacting,
        isExpired: alerts.cache?.state === 'expired',
        isVisible: isShown && (alerts.cache !== undefined || alerts.pressure !== undefined),
    };
}

/**
 * What the context row's live region says: one fixed phrase per notice state, never the countdown or the idle time. The
 * visible row ticks every minute, and a live region holding it would announce each tick; this text changes only when a
 * notice appears, the cache goes from expiring to expired, or a notice goes away.
 */
export function agentChatContextAnnouncement(alerts: AgentChatContextAlerts, t: Translate): string {
    const parts: string[] = [];
    if (alerts.cache)
        parts.push(
            t(
                (
                    {
                        compacting: 'agentChat.context.cacheCompactingAnnouncement',
                        expired: 'agentChat.context.cacheExpiredAnnouncement',
                        expiring: 'agentChat.context.cacheExpiringAnnouncement',
                    } as const
                )[alerts.cache.state],
            ),
        );
    if (alerts.pressure) parts.push(t('agentChat.context.pressureAnnouncement'));
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
