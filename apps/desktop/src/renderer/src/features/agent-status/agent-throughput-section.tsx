import type { AgentThroughput } from '@caxri/protocol';
import { RefreshCw } from 'lucide-react';

import { ReportCard, StatTile } from '../../components/report-card';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useRelativeTime } from '../../hooks/use-relative-time';
import {
    AGENT_THROUGHPUT_METHOD_NOTE,
    describeThroughputAggregate,
    describeThroughputSample,
    formatThroughputDuration,
    formatThroughputRate,
    recentAverageLabel,
    throughputRate,
} from '../status-bar/agent-throughput-label';
import type { AgentThroughputViewState } from './agent-throughput-state';
import { AGENT_THROUGHPUT_STATE_MESSAGES } from './agent-throughput-state';

const CHART_HEIGHT = 128;
const clockTime = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });

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
                    aria-label={`Output speed of the last ${samples.length} responses`}
                >
                    {samples.map((sample, index) => {
                        const description = `${describeThroughputSample(sample)}, finished ${clockTime.format(sample.completedAt)}`;
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
    const latest = state.kind === 'measured' ? state.latest : undefined;
    const lastResponseAgo = useRelativeTime(latest?.completedAt);
    if (state.kind !== 'measured')
        return (
            <ReportCard title="Output speed">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <p
                        className={
                            state.kind === 'error'
                                ? 'm-0 text-[12px] text-danger'
                                : 'm-0 text-[12px] text-muted'
                        }
                    >
                        {AGENT_THROUGHPUT_STATE_MESSAGES[state.kind]}
                    </p>
                    {state.kind === 'error' && (
                        <Button size="sm" variant="secondary" onClick={onRetry}>
                            <RefreshCw aria-hidden="true" size={12} />
                            Retry
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
                    label="Recent average"
                    value={rateValue(recent)}
                    detail={recentAverageLabel(throughput.recent.responseCount)}
                />
                <StatTile
                    label="Last response"
                    value={rateValue(throughputRate(state.latest))}
                    detail={
                        <>
                            {describeThroughputSample(state.latest)}
                            {lastResponseAgo && (
                                <span className="whitespace-nowrap">, {lastResponseAgo}</span>
                            )}
                        </>
                    }
                />
                <StatTile
                    label="This turn"
                    value={rateValue(throughputRate(throughput.turn))}
                    detail={
                        throughput.turn.responseCount > 0
                            ? describeThroughputAggregate(throughput.turn)
                            : 'No response yet in this turn'
                    }
                />
                <StatTile
                    label="First token"
                    value={
                        throughput.turnTimeToFirstTokenMs === undefined
                            ? undefined
                            : formatThroughputDuration(throughput.turnTimeToFirstTokenMs)
                    }
                    detail={
                        throughput.turnTimeToFirstTokenMs === undefined
                            ? 'Not reported for the last finished turn'
                            : 'In the last finished turn'
                    }
                />
                <StatTile
                    label="Agent Session"
                    value={rateValue(throughputRate(throughput.session))}
                    detail={describeThroughputAggregate(throughput.session)}
                />
            </div>
            <ReportCard
                title="Output speed"
                caption={
                    throughput.samples.length > 1
                        ? `Last ${throughput.samples.length} responses, oldest first; the dashed line is the recent average`
                        : undefined
                }
            >
                {throughput.samples.length > 1 ? (
                    <ThroughputChart average={recent} samples={throughput.samples} />
                ) : (
                    <p className="m-0 text-[12px] text-muted">
                        The chart appears after a second measured response.
                    </p>
                )}
                <p className="mt-3 mb-0 text-[11px] leading-snug text-muted">
                    {AGENT_THROUGHPUT_METHOD_NOTE}
                </p>
            </ReportCard>
        </>
    );
}
