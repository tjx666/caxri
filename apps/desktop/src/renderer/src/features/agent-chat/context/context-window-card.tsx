import type { AgentChatContextComposition, AgentChatContextRequest } from '@caxri/protocol';
import {
    agentChatContextLimit,
    agentChatContextPercent,
    formatPercent,
    formatTokens,
} from '@caxri/protocol';

import { ReportCard } from '../../../components/report-card';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { contextCategoryLabel } from './category-labels';
import { autoCompactAt, contextWindowSegments, segmentShade } from './composition';

function percentOf(tokens: number, window: number): string {
    return `${(window > 0 ? Math.min(1, tokens / window) * 100 : 0).toFixed(2)}%`;
}

/**
 * The window drawn in request order, with the free space as the track and a tick where Claude Code compacts. Under it,
 * on the same scale, how much of the latest request's prompt came from the cache: the two bars line up, so the cached
 * prefix visibly ends inside the part of the context the next write starts from.
 */
export function ContextWindowCard({
    composition,
    lastRequest,
}: {
    composition: AgentChatContextComposition;
    lastRequest: AgentChatContextRequest | undefined;
}) {
    const { t } = useTranslation();
    const { window } = composition;
    const segments = contextWindowSegments(composition);
    const shaded = segments.filter((segment) => segment.kind !== 'free');
    const free = segments.find((segment) => segment.kind === 'free');
    const deferred = composition.categories
        .filter((row) => row.kind === 'deferred')
        .reduce((sum, row) => sum + row.tokens, 0);
    const threshold = autoCompactAt(composition);
    // The headline shares the composer meter's denominator; the bar below still spans the whole window.
    const limit = agentChatContextLimit(window, threshold);
    const share = (tokens: number) => formatPercent(window > 0 ? tokens / window : 0);
    return (
        <ReportCard
            title={t('agentChat.contextPage.window.title')}
            caption={
                threshold
                    ? t('agentChat.contextPage.window.autoCompact', {
                          tokens: formatTokens(threshold),
                      })
                    : t('agentChat.contextPage.window.noAutoCompact')
            }
        >
            <div className="flex items-baseline gap-2">
                <span className="text-[15px] font-semibold tabular-nums">
                    {formatTokens(composition.totalTokens)}
                </span>
                <span className="text-[12px] text-muted tabular-nums">
                    / {formatTokens(limit)} ·{' '}
                    {agentChatContextPercent(composition.totalTokens, limit)}%
                </span>
            </div>
            <div className="relative mt-3">
                <div aria-hidden className="flex h-3 overflow-hidden rounded bg-chart/10">
                    {shaded.map((segment, index) => (
                        <Tooltip
                            key={segment.label}
                            anchorMode="cursor"
                            content={`${contextCategoryLabel(t, segment.label)} · ${formatTokens(segment.tokens)} · ${share(segment.tokens)}`}
                        >
                            <span
                                className={cn(
                                    'h-full border-r border-surface last:border-r-0',
                                    segmentShade(segment, index),
                                    // The reserve sits at the far end of the window, past the free space.
                                    segment.kind === 'buffer' && 'ml-auto',
                                )}
                                style={{ width: percentOf(segment.tokens, window) }}
                            />
                        </Tooltip>
                    ))}
                </div>
                {threshold && threshold < window && (
                    <span
                        aria-hidden
                        className="absolute -top-1 -bottom-1 w-px bg-foreground/60"
                        style={{ left: percentOf(threshold, window) }}
                    />
                )}
            </div>
            {lastRequest && <CachedPrefixTrack request={lastRequest} window={window} />}
            <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-x-6 gap-y-1.5">
                {shaded.map((segment, index) => (
                    <LegendRow
                        key={segment.label}
                        label={contextCategoryLabel(t, segment.label)}
                        shade={segmentShade(segment, index)}
                        share={share(segment.tokens)}
                        tokens={segment.tokens}
                    />
                ))}
                {free && (
                    <LegendRow
                        isMuted
                        label={contextCategoryLabel(t, free.label)}
                        shade="bg-chart/10"
                        share={share(free.tokens)}
                        tokens={free.tokens}
                    />
                )}
            </div>
            {deferred > 0 && (
                <p className="mt-3 mb-0 text-[11px] leading-[1.5] text-muted">
                    {t('agentChat.contextPage.window.deferred', { tokens: formatTokens(deferred) })}
                </p>
            )}
        </ReportCard>
    );
}

function CachedPrefixTrack({
    request,
    window,
}: {
    request: AgentChatContextRequest;
    window: number;
}) {
    const { t } = useTranslation();
    return (
        <div className="mt-2">
            <div aria-hidden className="flex h-1 overflow-hidden rounded-sm">
                <span
                    className="h-full bg-chart"
                    style={{ width: percentOf(request.cacheRead, window) }}
                />
                <span
                    className="h-full bg-chart/40"
                    style={{ width: percentOf(request.cacheWrite, window) }}
                />
                <span
                    className="h-full bg-muted/40"
                    style={{ width: percentOf(request.input, window) }}
                />
            </div>
            <p className="mt-1.5 mb-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                <span>{t('agentChat.contextPage.window.lastRequest')}</span>
                <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden className="size-2 rounded-sm bg-chart" />
                    {t('agentChat.contextPage.cache.read', {
                        tokens: formatTokens(request.cacheRead),
                    })}
                </span>
                <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden className="size-2 rounded-sm bg-chart/40" />
                    {t('agentChat.contextPage.cache.written', {
                        tokens: formatTokens(request.cacheWrite),
                    })}
                </span>
                {request.input > 0 && (
                    <span className="inline-flex items-center gap-1.5">
                        <span aria-hidden className="size-2 rounded-sm bg-muted/40" />
                        {t('agentChat.contextPage.cache.uncached', {
                            tokens: formatTokens(request.input),
                        })}
                    </span>
                )}
            </p>
        </div>
    );
}

/**
 * A swatch-label-figure legend row, the way the composer meter's card lists the window's rows.
 */
function LegendRow({
    shade,
    label,
    tokens,
    share,
    isMuted,
}: {
    shade: string;
    label: string;
    tokens: number;
    share: string;
    isMuted?: boolean;
}) {
    return (
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2 text-[12px]">
            <span aria-hidden className={cn('size-2 rounded-sm', shade)} />
            <span className={cn('truncate', isMuted ? 'text-muted' : 'text-foreground')}>
                {label}
            </span>
            <span className="text-right tabular-nums">{formatTokens(tokens)}</span>
            <span className="w-10 text-right text-[11px] text-muted tabular-nums">{share}</span>
        </div>
    );
}
