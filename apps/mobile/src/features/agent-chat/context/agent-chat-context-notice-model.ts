import type { AgentChatUsage } from '@caxri/protocol';
import {
    agentChatContextAlertsState,
    agentChatUndismissedContextAlerts,
    formatTokens,
    formatUsd,
} from '@caxri/protocol';

import type { Translate } from '../../../i18n';
import { translate } from '../../../i18n';
import { minutesText } from '../agent-chat-session-usage';

/**
 * Per Chat Terminal, the `lastResponseAt` of the reply after which the user dismissed the cache notice. Module state,
 * like Desktop's memory-only store: the notice is a cost hint, so forgetting a dismissal on relaunch costs one more
 * look at it, never a wrong answer.
 */
const dismissedResponseAt = new Map<string, number>();

export const dismissAgentChatCacheNotice = (terminalId: string, lastResponseAt: number): void => {
    dismissedResponseAt.set(terminalId, lastResponseAt);
};

export interface AgentChatContextNotice {
    /**
     * One line per notice, the cache line first.
     */
    lines: string[];
    /**
     * `warning` unless the cache already expired and nothing else needs attention: an expired cache is a cost fact, not
     * a suggestion.
     */
    tone: 'muted' | 'warning';
    /**
     * True while the nearly-full-context line shows, so the banner can offer Compact as Desktop's row does.
     */
    isContextFull: boolean;
    /**
     * Present while a cache notice shows: the reply the Dismiss button holds the notice for.
     */
    dismissAt?: number;
}

/**
 * The one banner above the composer for an idle Chat's context: the prompt cache is about to expire or has expired,
 * and/or the context is nearly full. The conditions are Desktop's (`agentChatContextAlertsState`), so both surfaces
 * raise the same notices. Mobile does not know the Server's idle-compaction setting, so it never reports the
 * `compacting` state and counts down to the expiry instead. Returns `undefined` when nothing needs attention.
 */
export function agentChatContextNotice(
    usage: AgentChatUsage | undefined,
    now: number,
    terminalId: string,
    t: Translate = translate,
): AgentChatContextNotice | undefined {
    if (!usage) return undefined;
    const alerts = agentChatUndismissedContextAlerts(
        agentChatContextAlertsState(usage, now, undefined),
        usage.lastResponseAt,
        dismissedResponseAt.get(terminalId),
    );
    const { cache, pressure } = alerts;
    const lines: string[] = [];
    if (cache) {
        const cost =
            usage.cacheRewriteUsd === undefined
                ? ''
                : t('chat.notice.cost', { cost: formatUsd(usage.cacheRewriteUsd) });
        // Rounded up so the countdown never claims `0m` while the cache is still warm.
        const remainingMs = Math.ceil((cache.remainingMs ?? 0) / 60_000) * 60_000;
        const remaining = minutesText(remainingMs, t);
        const idle = minutesText(cache.idleMs, t);
        lines.push(
            cache.state === 'expired'
                ? t('chat.notice.cacheExpired', { idle, cost })
                : t('chat.notice.cacheExpiring', { remaining, cost }),
        );
    }
    if (pressure)
        lines.push(
            t('chat.notice.pressure', {
                tokens: formatTokens(usage.totalTokens),
                window: formatTokens(pressure.limit),
            }),
        );
    if (lines.length === 0) return undefined;
    return {
        lines,
        tone: pressure || cache?.state !== 'expired' ? 'warning' : 'muted',
        isContextFull: pressure !== undefined,
        dismissAt: cache ? usage.lastResponseAt : undefined,
    };
}
