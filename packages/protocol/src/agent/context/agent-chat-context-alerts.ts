import type { AgentChatUsage } from '../agent-chat-usage.js';
import { AGENT_CHAT_HIGH_CONTEXT_SHARE, agentChatContextLimit } from '../agent-chat-usage.js';

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
 * as much as any ordinary turn does once a conversation grows, so a notice about it is noise. On a 1M window this keeps
 * a Chat under 200k quiet; one above idle compaction's floor is normally compacted before its cache expires anyway. On
 * a 200k window it stays below the cost floor above, so nothing changes there.
 */
const CACHE_NOTICE_MIN_SHARE = 0.2;

/**
 * How long before the prompt cache expires the composer starts counting down, so the user can still reply (or compact)
 * while the context is cached instead of learning about the expiry after it already cost a full re-read. A short cache
 * (Claude's 5m default) warns for its second half only, or the notice would appear the moment a reply lands.
 */
const CACHE_EXPIRY_LEAD_MS = 10 * 60_000;

/**
 * The prompt cache notice of an idle Chat, as figures: Desktop and Mobile each turn it into their own wording.
 */
interface AgentChatCacheAlertState {
    /**
     * `expiring` while the cache is still warm but within the warning lead of its TTL; `compacting` in that same span
     * when idle compaction will compact the Chat before it expires; `expired` once it is gone.
     */
    state: 'compacting' | 'expiring' | 'expired';
    cacheTtlMinutes: number;
    /**
     * Milliseconds since the last reply.
     */
    idleMs: number;
    /**
     * Milliseconds until the cache expires (`expiring`) or idle compaction runs (`compacting`); absent once `expired`.
     */
    remainingMs?: number;
}

/**
 * The context window notices of an idle Chat, as figures.
 */
export interface AgentChatContextAlertsState {
    cache?: AgentChatCacheAlertState;
    pressure?: {
        /**
         * The context limit the Chat is measured against (the compaction window).
         */
        limit: number;
    };
}

/**
 * Decides which context notices an idle Chat raises, so Desktop's composer and Mobile's Chat agree on when each shows.
 * `idleCompactionAt` is when idle compaction will compact this Chat (`agentChatIdleCompactionAt`), or `undefined` when
 * it will not.
 */
export function agentChatContextAlertsState(
    usage: AgentChatUsage | undefined,
    now: number,
    idleCompactionAt: number | undefined,
): AgentChatContextAlertsState {
    if (!usage || usage.totalTokens <= 0) return {};
    const alerts: AgentChatContextAlertsState = {};
    const { cacheTtlMinutes, lastResponseAt } = usage;
    if (
        cacheTtlMinutes &&
        lastResponseAt !== undefined &&
        isAgentChatCacheRewriteNoticeable(usage)
    ) {
        const idleMs = now - lastResponseAt;
        const ttlMs = cacheTtlMinutes * 60_000;
        if (idleMs >= ttlMs) {
            alerts.cache = { state: 'expired', cacheTtlMinutes, idleMs };
        } else if (idleCompactionAt !== undefined && now < idleCompactionAt) {
            if (idleMs >= ttlMs - CACHE_EXPIRY_LEAD_MS)
                alerts.cache = {
                    state: 'compacting',
                    cacheTtlMinutes,
                    idleMs,
                    remainingMs: idleCompactionAt - now,
                };
        } else if (idleMs >= ttlMs - Math.min(CACHE_EXPIRY_LEAD_MS, ttlMs / 2)) {
            alerts.cache = {
                state: 'expiring',
                cacheTtlMinutes,
                idleMs,
                remainingMs: ttlMs - idleMs,
            };
        }
    }
    const window = usage.compactWindow ?? usage.contextWindow;
    const limit = window && agentChatContextLimit(window, usage.autoCompactThreshold);
    if (limit && usage.totalTokens / limit >= AGENT_CHAT_HIGH_CONTEXT_SHARE)
        alerts.pressure = { limit };
    return alerts;
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
export function agentChatUndismissedContextAlerts<
    Alerts extends { cache?: unknown; pressure?: unknown },
>(
    alerts: Alerts,
    lastResponseAt: number | undefined,
    dismissedResponseAt: number | undefined,
): Alerts {
    if (
        dismissedResponseAt === undefined ||
        dismissedResponseAt !== lastResponseAt ||
        !alerts.cache
    )
        return alerts;
    return (alerts.pressure ? { pressure: alerts.pressure } : {}) as Alerts;
}
