import type { PointerEvent } from 'react';
import { useState } from 'react';

import { formatPercent, formatTokens } from '@caxri/protocol';
import { clamp } from 'es-toolkit';

import { ReportCard } from '../../../components/report-card';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { localizedDuration } from '../../../lib/usage-format';
import { cn } from '../../../lib/utilities';
import { agentChatDayLabel, agentChatMessageFullTime } from '../transcript/agent-chat-time';
import type { CacheAnalysis, CacheBreak, CacheRequestPoint } from './cache-analysis';
import { contextCategoryLabel } from './category-labels';
import type { ContextSegment } from './composition';
import { promptSegmentAt } from './composition';
import { cacheBreakReason, rewriteCost } from './suggestions';

/**
 * Breaks listed before "Show all", newest first.
 */
const COLLAPSED_BREAKS = 6;

const BREAK_TONE: Record<CacheBreak['kind'], string> = {
    compaction: 'text-muted',
    model: 'text-warning',
    ttl: 'text-warning',
    prefix: 'text-danger',
};

const breakGridClass =
    'grid grid-cols-[6.5rem_minmax(0,1fr)_minmax(7rem,10rem)_4rem_4rem] items-start gap-3';

/**
 * Every request of the conversation as a column of how its prompt was served (read from the cache, written to it, or
 * neither), with each break marked where it happened, then the breaks themselves, newest first, each saying why and
 * from which part of the context the rewrite began. Hovering a column or a break reads that request out above the
 * chart; nothing about it lives only in a tooltip.
 */
export function ContextCacheCard({
    analysis,
    segments,
    now,
    isHistoryTruncated,
}: {
    analysis: CacheAnalysis;
    /**
     * The window in request order as it is now, to name where a break's kept prefix ends. Absent while the provider is
     * not running.
     */
    segments: readonly ContextSegment[] | undefined;
    now: number;
    isHistoryTruncated: boolean;
}) {
    const { t } = useTranslation();
    const [focusIndex, setFocusIndex] = useState<number>();
    const [isShowingAll, setIsShowingAll] = useState(false);
    const { points, breaks } = analysis;
    const newestFirst = breaks.toReversed();
    const visibleBreaks = isShowingAll ? newestFirst : newestFirst.slice(0, COLLAPSED_BREAKS);
    return (
        <ReportCard
            title={t('agentChat.contextPage.cache.title')}
            caption={
                points.length > 0
                    ? t('agentChat.contextPage.cache.caption', {
                          count: points.length,
                          percent: formatPercent(analysis.hitRate),
                          ttl: localizedDuration(analysis.ttlMinutes * 60_000, t),
                      })
                    : undefined
            }
        >
            {points.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">
                    {t('agentChat.contextPage.cache.empty')}
                </p>
            ) : (
                <>
                    <CacheTimeline
                        breaks={breaks}
                        focusIndex={focusIndex}
                        points={points}
                        onFocus={setFocusIndex}
                    />
                    {isHistoryTruncated && (
                        <p className="mt-2 mb-0 text-[11px] text-muted">
                            {t('agentChat.contextPage.cache.truncated')}
                        </p>
                    )}
                    <h3 className="mt-5 mb-2 text-[12px] font-semibold">
                        {t('agentChat.contextPage.cache.breaksTitle')}
                    </h3>
                    {breaks.length === 0 ? (
                        <p className="m-0 text-[12px] text-success">
                            {t('agentChat.contextPage.cache.noBreaks')}
                        </p>
                    ) : (
                        <table
                            aria-label={t('agentChat.contextPage.cache.breaksTitle')}
                            className="grid w-full"
                        >
                            <thead className="contents">
                                <tr
                                    className={cn(
                                        breakGridClass,
                                        'pb-1.5 text-left text-[11px] text-muted',
                                    )}
                                >
                                    <th className="p-0 font-normal">
                                        {t('agentChat.contextPage.cache.when')}
                                    </th>
                                    <th className="p-0 font-normal">
                                        {t('agentChat.contextPage.cache.why')}
                                    </th>
                                    <th className="p-0 font-normal">
                                        {t('agentChat.contextPage.cache.kept')}
                                    </th>
                                    <th className="p-0 text-right font-normal">
                                        {t('agentChat.contextPage.cache.rewritten')}
                                    </th>
                                    <th className="p-0 text-right font-normal">
                                        {t('agentChat.contextPage.cache.cost')}
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="contents">
                                {visibleBreaks.map((item) => (
                                    <CacheBreakRow
                                        key={item.index}
                                        item={item}
                                        isFocused={focusIndex === item.index}
                                        now={now}
                                        segments={segments}
                                        onFocus={setFocusIndex}
                                    />
                                ))}
                            </tbody>
                        </table>
                    )}
                    {breaks.length > COLLAPSED_BREAKS && (
                        <button
                            type="button"
                            className="mt-2 cursor-pointer rounded-sm border-0 bg-transparent p-0 text-[11px] text-muted underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
                            onClick={() => setIsShowingAll((current) => !current)}
                        >
                            {isShowingAll
                                ? t('agentChat.contextPage.showFewer')
                                : t('agentChat.contextPage.showAll', {
                                      count: breaks.length,
                                  })}
                        </button>
                    )}
                </>
            )}
        </ReportCard>
    );
}

function CacheTimeline({
    points,
    breaks,
    focusIndex,
    onFocus,
}: {
    points: readonly CacheRequestPoint[];
    breaks: readonly CacheBreak[];
    focusIndex: number | undefined;
    onFocus: (index: number | undefined) => void;
}) {
    const { t } = useTranslation();
    const max = Math.max(1, ...points.map((point) => point.read + point.write + point.input));
    // Clamped because a refresh can shorten the history (the transcript tail drops old requests) while a column is
    // still hovered.
    const index = clamp(focusIndex ?? points.length - 1, 0, points.length - 1);
    const point = points[index];
    const focusedBreak = breaks.find((item) => item.index === index);
    const columnWidth = 100 / points.length;
    const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const box = event.currentTarget.getBoundingClientRect();
        const column = Math.floor(((event.clientX - box.left) / box.width) * points.length);
        onFocus(clamp(column, 0, points.length - 1));
    };
    return (
        <div>
            <div
                aria-live="polite"
                className="mb-2 flex min-h-5 flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-muted tabular-nums"
            >
                <span className="text-foreground">
                    {t('agentChat.contextPage.cache.request', {
                        index: index + 1,
                        time: agentChatMessageFullTime(point.at, t.locale),
                    })}
                </span>
                <span>
                    {t('agentChat.contextPage.cache.read', { tokens: formatTokens(point.read) })}
                </span>
                <span>
                    {t('agentChat.contextPage.cache.written', {
                        tokens: formatTokens(point.write),
                    })}
                </span>
                {point.input > 0 && (
                    <span>
                        {t('agentChat.contextPage.cache.uncached', {
                            tokens: formatTokens(point.input),
                        })}
                    </span>
                )}
                <span>
                    {t('agentChat.contextPage.cache.output', {
                        tokens: formatTokens(point.output),
                    })}
                </span>
                {point.model && <span className="font-mono">{point.model}</span>}
                {focusedBreak && (
                    <span className={BREAK_TONE[focusedBreak.kind]}>
                        {t(`agentChat.contextPage.breakKind.${focusedBreak.kind}`)}
                    </span>
                )}
            </div>
            <div className="flex gap-2">
                <div className="flex h-24 flex-col justify-between text-right text-[10px] text-muted tabular-nums">
                    <span>{formatTokens(max)}</span>
                    <span>0</span>
                </div>
                <div
                    aria-hidden
                    className="relative h-24 min-w-0 flex-1 cursor-crosshair border-b border-border"
                    onPointerLeave={() => onFocus(undefined)}
                    onPointerMove={onPointerMove}
                >
                    {breaks.map((item) => (
                        <span
                            key={item.index}
                            className={cn(
                                'absolute inset-y-0 w-px',
                                item.kind === 'compaction' ? 'bg-muted/50' : 'bg-danger/70',
                            )}
                            style={{ left: `${(item.index + 0.5) * columnWidth}%` }}
                        />
                    ))}
                    <span
                        className="absolute inset-y-0 bg-foreground/10"
                        style={{ left: `${index * columnWidth}%`, width: `${columnWidth}%` }}
                    />
                    <div
                        className={cn(
                            'absolute inset-0 flex items-end',
                            points.length <= 160 && 'gap-px',
                        )}
                    >
                        {points.map((item, position) => {
                            const prompt = item.read + item.write + item.input;
                            return (
                                <span
                                    // Requests never reorder, so the position is their identity.
                                    key={position}
                                    className="flex min-w-0 flex-1 flex-col-reverse"
                                    style={{ height: `${(prompt / max) * 100}%` }}
                                >
                                    <span className="bg-chart" style={{ flexGrow: item.read }} />
                                    <span
                                        className="bg-chart/40"
                                        style={{ flexGrow: item.write }}
                                    />
                                    <span
                                        className="bg-muted/40"
                                        style={{ flexGrow: item.input }}
                                    />
                                </span>
                            );
                        })}
                    </div>
                </div>
            </div>
            {/*
              The two timestamps sit on their own row and wrap instead of truncating, so a narrow tab still shows both
              times in full. The legend gets a row below, each label on one line so a CJK label cannot break mid-word.
            */}
            <div className="mt-1 flex flex-wrap justify-between gap-x-3 pl-8 text-[10px] text-muted tabular-nums">
                <span>{agentChatMessageFullTime(points[0].at, t.locale)}</span>
                <span className="text-right">
                    {agentChatMessageFullTime(points.at(-1)!.at, t.locale)}
                </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 pl-8 text-[10px] whitespace-nowrap text-muted">
                <span className="inline-flex items-center gap-1">
                    <span aria-hidden className="h-2 w-px shrink-0 bg-danger/70" />
                    {t('agentChat.contextPage.cache.legendMiss')}
                </span>
                <span className="inline-flex items-center gap-1">
                    <span aria-hidden className="h-2 w-px shrink-0 bg-muted/50" />
                    {t('agentChat.contextPage.cache.legendCompaction')}
                </span>
            </div>
        </div>
    );
}

function CacheBreakRow({
    item,
    isFocused,
    now,
    segments,
    onFocus,
}: {
    item: CacheBreak;
    isFocused: boolean;
    now: number;
    segments: readonly ContextSegment[] | undefined;
    onFocus: (index: number | undefined) => void;
}) {
    const { t } = useTranslation();
    const where = segments && item.kept > 0 ? promptSegmentAt(segments, item.kept) : undefined;
    const cost = rewriteCost(item.rewriteUsd);
    return (
        <tr
            className={cn(
                breakGridClass,
                '-mx-2 rounded-md border-t border-border px-2 py-2 text-[12px] first-of-type:border-t-0',
                isFocused && 'bg-elevated',
            )}
            onPointerEnter={() => onFocus(item.index)}
            onPointerLeave={() => onFocus(undefined)}
        >
            <td className="p-0 tabular-nums">
                <Tooltip content={agentChatMessageFullTime(item.at, t.locale)}>
                    <span>{agentChatDayLabel(item.at, now, t)}</span>
                </Tooltip>
            </td>
            <td className="min-w-0 p-0">
                <span className={cn('font-medium', BREAK_TONE[item.kind])}>
                    {t(`agentChat.contextPage.breakKind.${item.kind}`)}
                </span>
                <span className="mt-0.5 block text-[11px] leading-[1.5] text-pretty text-muted">
                    {cacheBreakReason(t, item)}
                </span>
            </td>
            <td className="min-w-0 p-0">
                <span
                    aria-hidden
                    className="mt-1.5 flex h-1 overflow-hidden rounded-sm bg-danger/25"
                >
                    <span
                        className="h-full bg-chart"
                        style={{
                            width: `${item.expected > 0 ? (item.kept / item.expected) * 100 : 0}%`,
                        }}
                    />
                </span>
                <span className="mt-1 block text-[11px] text-muted tabular-nums">
                    {t('agentChat.contextPage.cache.keptOf', {
                        kept: formatTokens(item.kept),
                        expected: formatTokens(item.expected),
                    })}
                </span>
                {where && (
                    <span className="block truncate text-[11px] text-muted">
                        {t('agentChat.contextPage.cache.from', {
                            segment: contextCategoryLabel(t, where.label),
                        })}
                    </span>
                )}
            </td>
            <td className="p-0 text-right tabular-nums">{formatTokens(item.rewritten)}</td>
            <td className="p-0 text-right text-muted tabular-nums">{cost ?? '—'}</td>
        </tr>
    );
}
