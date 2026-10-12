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
import { useRelativeTime } from '../../hooks/use-relative-time';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import {
    agentThroughputMethodNote,
    describeThroughputAggregate,
    describeThroughputSample,
    describeThroughputVariant,
    formatThroughputDuration,
    formatThroughputRate,
    recentAverageLabel,
    throughputRate,
    throughputSpeedLabel,
} from '../status-bar/agent-throughput-label';
import type { AgentThroughputViewState } from './agent-throughput-state';
import { AGENT_THROUGHPUT_STATE_MESSAGE_KEYS } from './agent-throughput-state';

const CHART_HEIGHT = 128;
const clockTime = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });
const groupedCount = new Intl.NumberFormat();

function rateValue(rate: number | undefined): string | undefined {
    return rate === undefined ? undefined : formatThroughputRate(rate);
}

/**
 * Per-response rates, oldest to newest, on a zero-based scale with the recent average drawn across it. Each bar spreads
 * over an equal share of the chart's width and is a focus stop whose tooltip carries the response's tokens, time, and
 * when it finished, so the chart can be read value by value from the keyboard too (at most
 * `AGENT_THROUGHPUT_SAMPLE_LIMIT` stops). The average line sits outside the list so the list holds only its items.
 */
function ThroughputChart({
    average,
    samples,
}: {
    average: number | undefined;
    samples: AgentThroughput['samples'];
}) {
    const { t } = useTranslation();
    const rates = samples.map((sample) => throughputRate(sample) ?? 0);
    const max = Math.max(...rates, average ?? 0);
    if (max <= 0) return null;
    return (
        <div className="flex gap-2">
            <div
                aria-hidden="true"
                className="flex flex-none flex-col justify-between text-right text-[11px] text-muted tabular-nums"
                style={{ height: CHART_HEIGHT }}
            >
                <span>{formatThroughputRate(max)}</span>
                <span>0</span>
            </div>
            <div className="relative min-w-0 flex-1" style={{ height: CHART_HEIGHT }}>
                <ul
                    className="m-0 flex h-full list-none items-end gap-1 border-b border-border p-0"
                    aria-label={t('agentStatus.throughput.chartLabel', { count: samples.length })}
                >
                    {samples.map((sample, index) => {
                        const description = t('agentStatus.throughput.barDescription', {
                            variant: describeThroughputVariant(sample, t),
                            sample: describeThroughputSample(sample, t),
                            time: clockTime.format(sample.completedAt),
                        });
                        return (
                            <Tooltip
                                key={`${sample.completedAt}:${sample.outputTokens}:${sample.durationMs}`}
                                content={description}
                            >
                                <li
                                    aria-label={description}
                                    className="flex h-full min-w-0 flex-1 items-end justify-center rounded-sm hover:bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] focus-visible:outline focus-visible:outline-accent"
                                    tabIndex={0}
                                >
                                    <div
                                        className={
                                            index === samples.length - 1
                                                ? 'w-full max-w-8 rounded-sm bg-foreground'
                                                : 'w-full max-w-8 rounded-sm bg-muted'
                                        }
                                        style={{
                                            height: Math.max(
                                                2,
                                                (rates[index] / max) * CHART_HEIGHT,
                                            ),
                                        }}
                                    />
                                </li>
                            </Tooltip>
                        );
                    })}
                </ul>
                {average !== undefined && (
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-0 border-t border-dashed border-muted"
                        style={{ bottom: (average / max) * CHART_HEIGHT }}
                    />
                )}
            </div>
        </div>
    );
}

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
                        <th className={tableHeadClass}>
                            {t('agentStatus.throughput.byModel.model')}
                        </th>
                        <th className={cn(tableHeadClass, 'w-36')}>
                            {t('agentStatus.throughput.byModel.mode')}
                        </th>
                        <th className={cn(numericHeadClass, 'w-24')}>
                            {t('agentStatus.throughput.byModel.rate')}
                        </th>
                        <th className={cn(numericHeadClass, 'w-24')}>
                            {t('agentStatus.throughput.byModel.responses')}
                        </th>
                        <th className={cn(numericHeadClass, 'w-28')}>
                            {t('agentStatus.throughput.byModel.tokens')}
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {variants.map((variant) => {
                        const rate = throughputRate(variant);
                        return (
                            <tr key={`${variant.model ?? ''}:${variant.speed ?? ''}`}>
                                <td className={cn(cellClass, 'font-mono text-[11px]')}>
                                    {variant.model ?? t('statusBar.throughput.unknownModel')}
                                </td>
                                <td className={cn(cellClass, variant.speed ? '' : 'text-muted')}>
                                    {throughputSpeedLabel(variant.speed, t)}
                                </td>
                                <td className={numericCellClass}>
                                    {rate === undefined ? '—' : formatThroughputRate(rate)}
                                </td>
                                <td className={numericCellClass}>
                                    {groupedCount.format(variant.responseCount)}
                                </td>
                                <td className={numericCellClass}>
                                    {groupedCount.format(variant.outputTokens)}
                                </td>
                            </tr>
                        );
                    })}
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
