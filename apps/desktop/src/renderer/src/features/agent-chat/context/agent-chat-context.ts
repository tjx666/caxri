import type { AgentChatCommand, AgentChatSnapshot, AgentChatUsage } from '@caxri/protocol';
import { formatTokens, formatUsd } from '@caxri/protocol';

import { translate } from '../../../i18n';
import { localizedDuration } from '../../../lib/usage-format';

/**
 * Share of the compaction window past which the context counts as high: the composer suggests compacting. Set close to
 * where the provider compacts on its own, so the suggestion arrives while compacting by hand still saves a turn,
 * without reading as a false alarm for most of a long conversation.
 *
 * The meter turns `--warning` at the same share rather than earlier: below it the ring stays a quiet neutral glyph, so
 * a color change means "worth compacting" and not "past half full". A full context is advice to compact, not a failure,
 * so it never turns `--danger` beside the composer's `--warning` suggestion.
 */
const HIGH_CONTEXT_SHARE = 0.85;

/**
 * The smallest estimated rewrite cost, in US dollars, worth a cache notice. Below it a full re-read costs too little to
 * interrupt the user about, and a notice shown after every idle pause would train them to ignore it.
 */
const CACHE_NOTICE_MIN_USD = 0.25;

/**
 * The context size a cache notice needs when the model has no price: roughly what {@link CACHE_NOTICE_MIN_USD} buys at a
 * mid-tier cache-write price, so an unpriced model is held to about the same bar.
 */
const CACHE_NOTICE_MIN_TOKENS = 40_000;

/**
 * The share of the context limit a cache notice needs. A conversation filling a small part of the window re-reads about
 * as much as any ordinary turn does once a conversation grows, so a notice about it is noise. On a 1M window this lands
 * near idle compaction's floor (`AGENT_CHAT_IDLE_COMPACTION_MIN_TOKENS`): a larger Chat is compacted before its cache
 * expires and a smaller one is not worth interrupting about. On a 200k window it stays below the cost floor above, so
 * nothing changes there.
 */
const CACHE_NOTICE_MIN_SHARE = 0.2;

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
     * Share of `window` in use, from 0 to 1.
     */
    used: number;
    totalTokens: number;
    /**
     * The window the breakdown fills: the provider's compaction window when it is smaller than the model's.
     */
    window: number;
    /**
     * The denominator of `used` and of every percentage: `compactAt` when the provider reports one, otherwise `window`.
     */
    limit: number;
    /**
     * Where the provider compacts on its own, when it says so.
     */
    compactAt?: number;
    /**
     * The model's own window, when the compaction window is smaller than it.
     */
    modelWindow?: number;
    tone: 'normal' | 'warning';
    breakdown: NonNullable<AgentChatUsage['breakdown']>;
}

/**
 * The whole-number share of `window` that `tokens` fill, from 0 to 100. The composer meter, its card, and the Context
 * tab's headline figures all round through here, so the two surfaces never show the same context as `1%` and `1.3%`.
 */
export function agentChatContextPercent(tokens: number, window: number): number {
    return window > 0 ? Math.round(Math.min(tokens / window, 1) * 100) : 0;
}

/**
 * The denominator every context percentage uses: where the provider compacts on its own when it says so, otherwise the
 * window pressure is measured against. The composer meter and the Context tab both read it here, so one Chat never
 * shows `85%` in one place and `71%` in the other for the same tokens.
 */
export function agentChatContextLimit(window: number, autoCompactAt: number | undefined): number {
    return autoCompactAt !== undefined && autoCompactAt > 0 ? autoCompactAt : window;
}

export function agentChatContextUsage(
    snapshot: Pick<AgentChatSnapshot, 'usage'> | undefined,
): AgentChatContextUsage | undefined {
    const usage = snapshot?.usage;
    const window = usage?.compactWindow ?? usage?.contextWindow;
    if (!usage || !window) return undefined;
    const limit = agentChatContextLimit(window, usage.autoCompactThreshold);
    const share = usage.totalTokens / limit;
    return {
        used: Math.min(share, 1),
        totalTokens: usage.totalTokens,
        window,
        limit,
        ...(usage.autoCompactThreshold && { compactAt: usage.autoCompactThreshold }),
        ...(usage.compactWindow &&
            usage.contextWindow &&
            usage.contextWindow > usage.compactWindow && { modelWindow: usage.contextWindow }),
        tone: share >= HIGH_CONTEXT_SHARE ? 'warning' : 'normal',
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
 * `idleCompactionAt` is when idle compaction will compact this Chat (`agentChatIdleCompactionAt`), or `undefined` when
 * it will not (the provider or context does not qualify, or the setting is off).
 */
export function agentChatContextAlerts(
    usage: AgentChatUsage | undefined,
    now: number,
    idleCompactionAt?: number,
): AgentChatContextAlerts {
    if (!usage || usage.totalTokens <= 0) return {};
    const alerts: AgentChatContextAlerts = {};
    const { cacheTtlMinutes, lastResponseAt } = usage;
    const tokens = formatTokens(usage.totalTokens);
    if (
        cacheTtlMinutes &&
        lastResponseAt !== undefined &&
        isAgentChatCacheRewriteNoticeable(usage)
    ) {
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
        } else if (idleCompactionAt !== undefined && now < idleCompactionAt) {
            if (idleMs >= ttlMs - CACHE_EXPIRY_LEAD_MS) {
                const remaining = roundedUpDuration(idleCompactionAt - now);
                alerts.cache = {
                    state: 'compacting',
                    text: translate('agentChat.context.cacheCompactingText', { remaining }),
                    detail: `${translate('agentChat.context.cacheCompactingDetail', { minutes: cacheTtlMinutes, remaining, tokens })}${costNote}`,
                };
            }
        } else if (idleMs >= ttlMs - Math.min(CACHE_EXPIRY_LEAD_MS, ttlMs / 2)) {
            const remaining = roundedUpDuration(ttlMs - idleMs);
            alerts.cache = {
                state: 'expiring',
                text: translate('agentChat.context.cacheExpiringText', { remaining, cost }),
                detail: `${translate('agentChat.context.cacheExpiringDetail', { minutes: cacheTtlMinutes, remaining, tokens })}${costNote}`,
            };
        }
    }
    const window = usage.compactWindow ?? usage.contextWindow;
    const limit = window && agentChatContextLimit(window, usage.autoCompactThreshold);
    if (limit && usage.totalTokens / limit >= HIGH_CONTEXT_SHARE)
        alerts.pressure = {
            text: translate('agentChat.context.pressureText', {
                tokens,
                window: formatTokens(limit),
            }),
            detail: translate('agentChat.context.pressureDetail', {
                percent: agentChatContextPercent(usage.totalTokens, limit),
            }),
        };
    return alerts;
}

/**
 * A countdown rounded up to the minute, so it never claims `0m` while there is still time left.
 */
function roundedUpDuration(ms: number): string {
    return localizedDuration(Math.ceil(ms / 60_000) * 60_000);
}

/**
 * Whether an expiring or expired prompt cache is worth a notice: the estimated rewrite costs at least
 * {@link CACHE_NOTICE_MIN_USD}, or, for a model with no price, the context holds at least {@link CACHE_NOTICE_MIN_TOKENS}
 * tokens; and, when the window is known, the context fills at least {@link CACHE_NOTICE_MIN_SHARE} of its limit. A small
 * conversation re-reads for cents, and a permanent notice about it is noise.
 */
export function isAgentChatCacheRewriteNoticeable(
    usage: Pick<
        AgentChatUsage,
        | 'autoCompactThreshold'
        | 'cacheRewriteUsd'
        | 'compactWindow'
        | 'contextWindow'
        | 'totalTokens'
    >,
): boolean {
    const window = usage.compactWindow ?? usage.contextWindow;
    if (
        window &&
        usage.totalTokens / agentChatContextLimit(window, usage.autoCompactThreshold) <
            CACHE_NOTICE_MIN_SHARE
    )
        return false;
    return usage.cacheRewriteUsd === undefined
        ? usage.totalTokens >= CACHE_NOTICE_MIN_TOKENS
        : usage.cacheRewriteUsd >= CACHE_NOTICE_MIN_USD;
}

/**
 * The alerts left to show once the user dismissed the cache notice. A dismissal holds for the reply it was made after
 * (`dismissedResponseAt` is that reply's `lastResponseAt`), so the next reply, which restarts the cache, can raise the
 * notice again; the context-pressure notice is never dismissed with it.
 */
export function agentChatUndismissedContextAlerts(
    alerts: AgentChatContextAlerts,
    lastResponseAt: number | undefined,
    dismissedResponseAt: number | undefined,
): AgentChatContextAlerts {
    if (
        dismissedResponseAt === undefined ||
        dismissedResponseAt !== lastResponseAt ||
        !alerts.cache
    )
        return alerts;
    return alerts.pressure ? { pressure: alerts.pressure } : {};
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
                (
                    {
                        compacting: 'agentChat.context.cacheCompactingAnnouncement',
                        expired: 'agentChat.context.cacheExpiredAnnouncement',
                        expiring: 'agentChat.context.cacheExpiringAnnouncement',
                    } as const
                )[alerts.cache.state],
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
