import type { AgentChatContextComposition, AgentChatUsage } from '@caxri/protocol';
import { agentChatCacheClock, formatPercent, formatTokens, formatUsd } from '@caxri/protocol';

import { useClockTick } from '@/hooks/use-clock-tick';

import { StatTile } from '../../../components/report-card';
import { useTranslation } from '../../../i18n';
import { formatCount } from '../../../lib/locale-format';
import { localizedDuration } from '../../../lib/usage-format';
import type { CacheAnalysis } from './cache-analysis';
import { contextTileFigures } from './composition';

/**
 * The tab's headline figures: how full the window is, whether the prompt cache is still warm, how much of the
 * conversation it served, and what its misses cost.
 */
export function ContextTiles({
    analysis,
    composition,
    usage,
}: {
    analysis: CacheAnalysis;
    composition: AgentChatContextComposition | undefined;
    usage: AgentChatUsage | undefined;
}) {
    const { t } = useTranslation();
    const context = contextTileFigures(composition, usage);
    return (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-2">
            <StatTile
                label={t('agentChat.contextPage.tile.context')}
                value={context.value}
                detail={
                    context.percent === undefined
                        ? undefined
                        : [
                              `${context.percent}%`,
                              context.threshold &&
                                  t('agentChat.contextPage.tile.compactsAt', {
                                      tokens: formatTokens(context.threshold),
                                  }),
                          ]
                              .filter(Boolean)
                              .join(' · ')
                }
            />
            <CacheClockTile analysis={analysis} usage={usage} />
            <StatTile
                label={t('agentChat.contextPage.tile.hitRate')}
                value={analysis.points.length > 0 ? formatPercent(analysis.hitRate) : undefined}
                detail={
                    analysis.points.length > 0
                        ? t('agentChat.contextPage.tile.hitRateDetail', {
                              read: formatTokens(analysis.readTokens),
                              written: formatTokens(analysis.writeTokens),
                          })
                        : t('agentChat.contextPage.cache.empty')
                }
            />
            <StatTile
                label={t('agentChat.contextPage.tile.misses')}
                value={analysis.points.length > 0 ? formatCount(analysis.misses) : undefined}
                detail={
                    analysis.misses > 0
                        ? [
                              t('agentChat.contextPage.tile.missesRewritten', {
                                  tokens: formatTokens(analysis.missTokens),
                              }),
                              analysis.missUsd > 0 && `~${formatUsd(analysis.missUsd)}`,
                          ]
                              .filter(Boolean)
                              .join(' · ')
                        : t('agentChat.contextPage.tile.noMisses')
                }
            />
        </div>
    );
}

/**
 * Ticks once a minute on its own, so only this tile re-renders while the cache counts down.
 */
function CacheClockTile({
    analysis,
    usage,
}: {
    analysis: CacheAnalysis;
    usage: AgentChatUsage | undefined;
}) {
    const { t } = useTranslation();
    const now = useClockTick('minute');
    const ttlMinutes = usage?.cacheTtlMinutes ?? analysis.ttlMinutes;
    const lastAt = usage?.lastResponseAt ?? analysis.points.at(-1)?.at;
    const clock = agentChatCacheClock(lastAt, ttlMinutes, now);
    const ttl = localizedDuration(ttlMinutes * 60_000, t);
    const rewrite =
        usage && usage.totalTokens > 0
            ? t('agentChat.contextPage.tile.rewrite', {
                  tokens: formatTokens(usage.totalTokens),
                  cost:
                      usage.cacheRewriteUsd === undefined
                          ? ''
                          : ` (~${formatUsd(usage.cacheRewriteUsd)})`,
              })
            : undefined;
    return (
        <StatTile
            label={t('agentChat.contextPage.tile.cache')}
            value={
                clock
                    ? clock.state === 'warm'
                        ? t('agentChat.contextPage.tile.warm', {
                              // Rounded up so the countdown never claims `0m` while the cache is still warm.
                              remaining: localizedDuration(
                                  Math.ceil(clock.remainingMs / 60_000) * 60_000,
                                  t,
                              ),
                          })
                        : t('agentChat.contextPage.tile.expired', {
                              idle: localizedDuration(clock.idleMs, t),
                          })
                    : undefined
            }
            detail={
                rewrite && clock?.state === 'expired'
                    ? `${t('agentChat.contextPage.tile.ttl', { ttl })} · ${rewrite}`
                    : t('agentChat.contextPage.tile.ttl', { ttl })
            }
        />
    );
}
