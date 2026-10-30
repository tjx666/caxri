import type { AgentChatUsage, AgentUsageReadout } from '@caxri/protocol';
import {
    agentChatCacheClock,
    agentChatContextPercent,
    agentChatContextUsage,
    agentUsageCostLabel,
    formatPercent,
    formatTokens,
    formatUsd,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

/**
 * The composer's context ring, as on Desktop: a quiet neutral glyph with no number until the context reaches the share
 * where compacting is suggested, then the warning tone with the percentage.
 */
export interface AgentChatContextRing {
    /**
     * Share of the window the ring fills, from 0 to 1.
     */
    used: number;
    percent: number;
    isWarning: boolean;
    accessibilityLabel: string;
}

/**
 * One label and figure in the Session usage sheet.
 */
export interface AgentChatSessionUsageRow {
    /**
     * Lowercase kebab-case: it becomes the row's `agent-chat-usage-<key>` testID, and Android Acceptance only reads
     * lowercase check ids (`isAndroidCheckId`).
     */
    key: string;
    label: string;
    value: string;
    /**
     * A muted line under the row that explains the figure.
     */
    detail?: string;
}

export interface AgentChatSessionUsageView {
    /**
     * How full the context window is, with a bar; absent until the provider reports a window size.
     */
    context?: {
        value: string;
        used: number;
        isWarning: boolean;
        note?: string;
    };
    /**
     * The whole conversation's tokens and estimated cost; absent until the conversation recorded usage.
     */
    conversation: AgentChatSessionUsageRow[];
    /**
     * Whether the prompt cache still holds and how much of the conversation it served.
     */
    cache: AgentChatSessionUsageRow[];
}

/**
 * `1h 5m` or `42m`, rounded to the minute; the cache clock never needs seconds.
 */
export function minutesText(ms: number, t: Translate): string {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    const hours = Math.floor(minutes / 60);
    return hours > 0
        ? t('chat.usage.durationHours', { hours, minutes: minutes % 60 })
        : t('chat.usage.durationMinutes', { minutes });
}

export function agentChatContextRing(
    usage: AgentChatUsage | undefined,
    t: Translate = translate,
): AgentChatContextRing | undefined {
    const context = agentChatContextUsage(usage);
    if (!context) return undefined;
    const percent = agentChatContextPercent(context.totalTokens, context.limit);
    return {
        used: context.used,
        percent,
        isWarning: context.tone === 'warning',
        accessibilityLabel: t('chat.usage.ringLabel', {
            percent,
            tokens: formatTokens(context.totalTokens),
            window: formatTokens(context.limit),
        }),
    };
}

function contextSection(
    usage: AgentChatUsage | undefined,
    t: Translate,
): AgentChatSessionUsageView['context'] {
    const context = agentChatContextUsage(usage);
    if (!context) return undefined;
    const percent = agentChatContextPercent(context.totalTokens, context.limit);
    return {
        value: t('chat.usage.contextValue', {
            tokens: formatTokens(context.totalTokens),
            window: formatTokens(context.limit),
            percent,
        }),
        used: context.used,
        isWarning: context.tone === 'warning',
        // The same notes Desktop's meter card gives under its bar.
        note: context.modelWindow
            ? t('chat.usage.contextCompactWindow', {
                  window: formatTokens(context.limit),
                  modelWindow: formatTokens(context.modelWindow),
              })
            : context.compactAt
              ? t('chat.usage.contextAutoCompact', { tokens: formatTokens(context.compactAt) })
              : undefined,
    };
}

function conversationRows(
    readout: AgentUsageReadout | undefined,
    t: Translate,
): AgentChatSessionUsageRow[] {
    if (!readout) return [];
    const { tokens } = readout;
    const cost = agentUsageCostLabel(readout);
    const rows: AgentChatSessionUsageRow[] = [
        {
            key: 'tokens',
            label: t('chat.usage.tokens'),
            value: formatTokens(tokens.total),
            detail: [
                t('chat.usage.tokensInput', { count: formatTokens(tokens.input) }),
                t('chat.usage.tokensOutput', { count: formatTokens(tokens.output) }),
                // Cache kinds the provider never reported are left out rather than listed as zero, as on Desktop.
                tokens.cacheRead > 0 &&
                    t('chat.usage.tokensCacheRead', { count: formatTokens(tokens.cacheRead) }),
                tokens.cacheWrite > 0 &&
                    t('chat.usage.tokensCacheWrite', { count: formatTokens(tokens.cacheWrite) }),
            ]
                .filter(Boolean)
                .join(' · '),
        },
        {
            key: 'cost',
            label: t('chat.usage.cost'),
            value: cost ?? t('chat.usage.costUnknown'),
            detail:
                cost === undefined
                    ? t('chat.usage.costNoPrice')
                    : readout.unpricedModels.length > 0
                      ? t('chat.usage.costPartial', { models: readout.unpricedModels.join(', ') })
                      : t('chat.usage.costNote'),
        },
    ];
    if (readout.models.length > 0)
        rows.push({
            key: 'models',
            label: t('chat.usage.models'),
            value: readout.models.join(', '),
        });
    return rows;
}

function cacheRows(
    usage: AgentChatUsage | undefined,
    readout: AgentUsageReadout | undefined,
    now: number,
    t: Translate,
): AgentChatSessionUsageRow[] {
    const rows: AgentChatSessionUsageRow[] = [];
    const ttlMinutes = usage?.cacheTtlMinutes;
    const clock =
        ttlMinutes === undefined
            ? undefined
            : agentChatCacheClock(usage?.lastResponseAt, ttlMinutes, now);
    if (clock && ttlMinutes !== undefined && usage) {
        const kept = t('chat.usage.cacheTtl', { ttl: minutesText(ttlMinutes * 60_000, t) });
        const rewrite =
            usage.totalTokens > 0
                ? t('chat.usage.cacheRewrite', {
                      tokens: formatTokens(usage.totalTokens),
                      cost:
                          usage.cacheRewriteUsd === undefined
                              ? ''
                              : ` (~${formatUsd(usage.cacheRewriteUsd)})`,
                  })
                : undefined;
        // Rounded up so the countdown never claims `0m` while the cache is still warm.
        const remaining = minutesText(Math.ceil(clock.remainingMs / 60_000) * 60_000, t);
        rows.push(
            clock.state === 'warm'
                ? {
                      key: 'clock',
                      label: t('chat.usage.cacheState'),
                      value: t('chat.usage.cacheWarm', { remaining }),
                      detail: kept,
                  }
                : {
                      key: 'clock',
                      label: t('chat.usage.cacheState'),
                      value: t('chat.usage.cacheExpired', { idle: minutesText(clock.idleMs, t) }),
                      detail: rewrite ? `${kept} ${rewrite}` : kept,
                  },
        );
    }
    if (readout) {
        const { cacheRead, cacheWrite, input } = readout.tokens;
        const prompt = input + cacheRead + cacheWrite;
        // The prompt is `input + cacheRead + cacheWrite`, as on Desktop's Context tab; a provider without cache figures
        // has no hit rate to show.
        if (cacheRead + cacheWrite > 0 && prompt > 0)
            rows.push({
                key: 'hit-rate',
                label: t('chat.usage.cacheHitRate'),
                value: formatPercent(cacheRead / prompt),
                detail: t('chat.usage.cacheHitRateDetail', {
                    read: formatTokens(cacheRead),
                    written: formatTokens(cacheWrite),
                }),
            });
    }
    return rows;
}

/**
 * Everything the Session usage sheet shows: the context window from the Chat's snapshot, and the whole conversation's
 * tokens, estimated cost, and prompt cache from `mobile.agentChat.readUsage`, the figures Desktop's composer meter,
 * Context tab, and status bar chip show.
 */
export function agentChatSessionUsageView(
    usage: AgentChatUsage | undefined,
    readout: AgentUsageReadout | undefined,
    now: number,
    t: Translate = translate,
): AgentChatSessionUsageView {
    return {
        context: contextSection(usage, t),
        conversation: conversationRows(readout, t),
        cache: cacheRows(usage, readout, now, t),
    };
}
