import type { AgentThroughput, AgentThroughputVariant } from '@caxri/protocol';
import { RefreshCw } from 'lucide-react';

import { ReportCard, StatTile } from '../../components/report-card';
import {
    cellClass,
    numericCellClass,
    numericHeadClass,
    tableHeadClass,
} from '../../components/report-table-classes';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useChartKeyboardCursor } from '../../hooks/use-chart-keyboard-cursor';
import { useRelativeTime } from '../../hooks/use-relative-time';
import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import { CHART_CURSOR_CLASS } from '../../lib/chart-cursor';
import { formatCount } from '../../lib/locale-format';
import { cn } from '../../lib/utilities';
import {
    agentThroughputMethodNote,
    describeThroughputAggregate,
    describeThroughputSample,
    formatThroughputDuration,
    formatThroughputRate,
    recentAverageLabel,
    throughputRate,
    throughputSpeedLabel,
} from '../status-bar/agent-throughput-label';
import type { AgentThroughputViewState } from './agent-throughput-state';
import {
    AGENT_THROUGHPUT_STATE_MESSAGE_KEYS,
    throughputBarDescription,
} from './agent-throughput-state';

const CHART_HEIGHT = 128;

function rateValue(rate: number | undefined): string | undefined {
    return rate === undefined ? undefined : formatThroughputRate(rate);
}

/**
 * Per-response rates, oldest to newest, on a zero-based scale with the recent average drawn across it and labeled with
 * its value. The chart is one focus stop, as the Usage page's charts are: Tab reaches its summary, and the arrow keys
 * step through the responses (`lib/chart-cursor.ts`), ringing the bar and showing its Tooltip text in the caption,
 * announced through a polite live region. Bars paint `--chart`, the newest at full strength.
 */
function ThroughputChart({
    average,
    samples,
}: {
    average: number | undefined;
    samples: AgentThroughput['samples'];
}) {
    const { t } = useTranslation();
    const keyboard = useChartKeyboardCursor({ kind: 'linear', count: samples.length }, 'responses');
    const rates = samples.map((sample) => throughputRate(sample) ?? 0);
    const max = Math.max(...rates, average ?? 0);
    if (max <= 0) return null;
    const cursor = keyboard.cursor;
    const cursorText =
        cursor === undefined ? undefined : throughputBarDescription(t, samples[cursor]);
    const averageLabel =
        average === undefined
            ? undefined
            : t('agentStatus.throughput.averageLine', { rate: formatThroughputRate(average) });
    return (
        <>
            <div className="flex gap-2">
                <div
                    aria-hidden="true"
                    className="flex flex-none flex-col justify-between text-right text-[11px] text-muted tabular-nums"
                    style={{ height: CHART_HEIGHT }}
                >
                    <span>{formatThroughputRate(max)}</span>
                    <span>0</span>
                </div>
                <div
                    aria-label={[
                        t('agentStatus.throughput.chartLabel', { count: samples.length }),
                        averageLabel,
                    ]
                        .filter(Boolean)
                        .join('. ')}
                    className="relative min-w-0 flex-1 rounded-sm focus-visible:outline focus-visible:outline-accent"
                    role="img"
                    style={{ height: CHART_HEIGHT }}
                    tabIndex={0}
                    onBlur={keyboard.onBlur}
                    onKeyDown={keyboard.onKeyDown}
                >
                    <div className="flex h-full items-end gap-1 border-b border-border">
                        {/* The full-height column is the trigger, so a slow response is as easy to hover as the fastest. */}
                        {samples.map((sample, index) => (
                            <Tooltip
                                key={`${sample.completedAt}:${sample.outputTokens}:${sample.durationMs}`}
                                content={throughputBarDescription(t, sample)}
                            >
                                <div
                                    className={cn(
                                        'flex h-full min-w-0 flex-1 items-end justify-center rounded-sm hover:bg-list-hover-background',
                                        index === cursor && CHART_CURSOR_CLASS,
                                    )}
                                >
                                    <div
                                        className={cn(
                                            'w-full max-w-8 rounded-sm',
                                            index === samples.length - 1
                                                ? 'bg-chart'
                                                : 'bg-chart/50',
                                        )}
                                        style={{
                                            height: Math.max(
                                                2,
                                                (rates[index] / max) * CHART_HEIGHT,
                                            ),
                                        }}
                                    />
                                </div>
                            </Tooltip>
                        ))}
                    </div>
                    {average !== undefined && (
                        <div
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-x-0 border-t border-dashed border-muted"
                            style={{ bottom: (average / max) * CHART_HEIGHT }}
                        >
                            <span className="absolute right-0 bottom-0.5 rounded-sm bg-surface px-1 text-[11px] leading-none text-muted tabular-nums">
                                {averageLabel}
                            </span>
                        </div>
                    )}
                </div>
            </div>
            {/* Reserved even when empty, so stepping into the chart does not push the method note down. */}
            <p className="mt-2 mb-0 min-h-4 text-[11px] text-muted" aria-hidden="true">
                {cursorText}
            </p>
            <span className="sr-only" aria-live="polite">
                {cursorText}
            </span>
        </>
    );
}

interface ByModelColumn {
    key: 'model' | 'mode' | 'rate' | 'responses' | 'tokens';
    isNumeric?: boolean;
    width?: string;
    cellClassName: (variant: AgentThroughputVariant) => string;
    value: (variant: AgentThroughputVariant, t: Translate) => string;
}

const BY_MODEL_COLUMNS: readonly ByModelColumn[] = [
    {
        key: 'model',
        cellClassName: () => cn(cellClass, 'font-mono text-[11px]'),
        value: (variant, t) => variant.model ?? t('statusBar.throughput.unknownModel'),
    },
    {
        key: 'mode',
        width: 'w-36',
        cellClassName: (variant) => cn(cellClass, variant.speed ? '' : 'text-muted'),
        value: (variant, t) => throughputSpeedLabel(variant.speed, t),
    },
    {
        key: 'rate',
        isNumeric: true,
        width: 'w-24',
        cellClassName: () => numericCellClass,
        value: (variant) => {
            const rate = throughputRate(variant);
            return rate === undefined ? '—' : formatThroughputRate(rate);
        },
    },
    {
        key: 'responses',
        isNumeric: true,
        width: 'w-24',
        cellClassName: () => numericCellClass,
        value: (variant) => formatCount(variant.responseCount),
    },
    {
        key: 'tokens',
        isNumeric: true,
        width: 'w-28',
        cellClassName: () => numericCellClass,
        value: (variant) => formatCount(variant.outputTokens),
    },
];

/**
 * The Agent Session's responses split by model and mode, so a model switch or Fast mode can be compared at a glance
 * instead of being averaged into one figure. The note explains rows without a mode only when one is listed.
 */
function ThroughputByModel({ variants }: { variants: readonly AgentThroughputVariant[] }) {
    const { t } = useTranslation();
    return (
        <ReportCard
            title={t('agentStatus.throughput.byModel')}
            caption={t('agentStatus.throughput.byModelCaption')}
        >
            <table className="w-full table-fixed border-collapse">
                <thead>
                    <tr>
                        {BY_MODEL_COLUMNS.map((column) => (
                            <th
                                key={column.key}
                                className={cn(
                                    column.isNumeric ? numericHeadClass : tableHeadClass,
                                    column.width,
                                )}
                            >
                                {t(`agentStatus.throughput.byModel.${column.key}`)}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {variants.map((variant) => (
                        <tr key={`${variant.model ?? ''}:${variant.speed ?? ''}`}>
                            {BY_MODEL_COLUMNS.map((column) => (
                                <td key={column.key} className={column.cellClassName(variant)}>
                                    {column.value(variant, t)}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
            {variants.some((variant) => variant.speed === undefined) && (
                <p className="mt-3 mb-0 text-[11px] leading-snug text-muted">
                    {t('agentStatus.throughput.byModel.unknownNote')}
                </p>
            )}
        </ReportCard>
    );
}

/**
 * The Agent status tab's speed report: the status-bar card's figures as tiles, led by the same recent average the chip
 * shows, and every retained response as a bar. Tiles sit outside the chart card so a tile's border never stacks inside
 * a card's border.
 */
export function AgentThroughputSection({
    onRetry,
    state,
}: {
    onRetry: () => void;
    state: AgentThroughputViewState;
}) {
    const { t } = useTranslation();
    const latest = state.kind === 'measured' ? state.latest : undefined;
    const lastResponseAgo = useRelativeTime(latest?.completedAt);
    if (state.kind !== 'measured')
        return (
            <ReportCard title={t('agentStatus.throughput.title')}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <p
                        className={
                            state.kind === 'error'
                                ? 'm-0 text-[12px] text-danger'
                                : 'm-0 text-[12px] text-muted'
                        }
                    >
                        {t(AGENT_THROUGHPUT_STATE_MESSAGE_KEYS[state.kind])}
                    </p>
                    {state.kind === 'error' && (
                        <Button size="sm" variant="secondary" onClick={onRetry}>
                            <RefreshCw aria-hidden="true" size={12} />
                            {t('common.retry')}
                        </Button>
                    )}
                </div>
            </ReportCard>
        );
    const { throughput } = state;
    const recent = throughputRate(throughput.recent);
    return (
        <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2">
                <StatTile
                    label={t('agentStatus.throughput.recentAverage')}
                    value={rateValue(recent)}
                    detail={recentAverageLabel(throughput.recent.responseCount, t)}
                />
                <StatTile
                    label={t('agentStatus.throughput.lastResponse')}
                    value={rateValue(throughputRate(state.latest))}
                    detail={
                        <>
                            {describeThroughputSample(state.latest, t)}
                            {lastResponseAgo && (
                                <span className="whitespace-nowrap">, {lastResponseAgo}</span>
                            )}
                        </>
                    }
                />
                <StatTile
                    label={t('agentStatus.throughput.thisTurn')}
                    value={rateValue(throughputRate(throughput.turn))}
                    detail={
                        throughput.turn.responseCount > 0
                            ? describeThroughputAggregate(throughput.turn, t)
                            : t('agentStatus.throughput.noResponseThisTurn')
                    }
                />
                <StatTile
                    label={t('agentStatus.throughput.firstToken')}
                    value={
                        throughput.turnTimeToFirstTokenMs === undefined
                            ? undefined
                            : formatThroughputDuration(throughput.turnTimeToFirstTokenMs)
                    }
                    detail={t(
                        throughput.turnTimeToFirstTokenMs === undefined
                            ? 'agentStatus.throughput.firstTokenNotReported'
                            : 'agentStatus.throughput.firstTokenLastTurn',
                    )}
                />
                <StatTile
                    label={t('agentStatus.throughput.agentSession')}
                    value={rateValue(throughputRate(throughput.session))}
                    detail={describeThroughputAggregate(throughput.session, t)}
                />
            </div>
            <ReportCard
                title={t('agentStatus.throughput.title')}
                caption={
                    throughput.samples.length > 1
                        ? t('agentStatus.throughput.chartCaption', {
                              count: throughput.samples.length,
                          })
                        : undefined
                }
            >
                {throughput.samples.length > 1 ? (
                    <ThroughputChart average={recent} samples={throughput.samples} />
                ) : (
                    <p className="m-0 text-[12px] text-muted">
                        {t('agentStatus.throughput.chartPending')}
                    </p>
                )}
                <p className="mt-3 mb-0 text-[11px] leading-snug text-muted">
                    {agentThroughputMethodNote(t)}
                </p>
            </ReportCard>
            {throughput.byModel.length > 0 && <ThroughputByModel variants={throughput.byModel} />}
        </>
    );
}
