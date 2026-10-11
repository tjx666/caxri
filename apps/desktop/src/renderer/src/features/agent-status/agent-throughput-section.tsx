import type { AgentThroughput } from '@caxri/protocol';

import { ReportCard, StatTile } from '../../components/report-card';
import { Tooltip } from '../../components/ui/tooltip';
import { useRelativeTime } from '../../hooks/use-relative-time';
import {
    AGENT_THROUGHPUT_METHOD_NOTE,
    describeThroughputAggregate,
    describeThroughputSample,
    formatThroughputDuration,
    formatThroughputRate,
    throughputRate,
} from '../status-bar/agent-throughput-label';

const CHART_HEIGHT = 128;
const clockTime = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });

function rateLabel(rate: number | undefined): string {
    return rate === undefined ? 'Not measured' : formatThroughputRate(rate);
}

/**
 * Per-response rates, oldest to newest, on a zero-based scale with the recent average drawn across it. Each bar's
 * tooltip carries the response's tokens, time, and when it finished, so the chart can be read value by value.
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
            <div
                className="relative flex min-w-0 flex-1 items-end gap-1 border-b border-border"
                role="list"
                aria-label={`Output speed of the last ${samples.length} responses`}
                style={{ height: CHART_HEIGHT }}
            >
                {average !== undefined && (
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-0 border-t border-dashed border-muted"
                        style={{ bottom: (average / max) * CHART_HEIGHT }}
                    />
                )}
                {samples.map((sample, index) => {
                    const description = `${describeThroughputSample(sample)}, finished ${clockTime.format(sample.completedAt)}`;
                    return (
                        <Tooltip key={`${sample.completedAt}:${index}`} content={description}>
                            <div
                                aria-label={description}
                                className="flex h-full max-w-6 min-w-0 flex-1 items-end rounded-sm hover:bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)]"
                                role="listitem"
                            >
                                <div
                                    className={
                                        index === samples.length - 1
                                            ? 'w-full rounded-sm bg-foreground'
                                            : 'w-full rounded-sm bg-muted'
                                    }
                                    style={{
                                        height: Math.max(2, (rates[index] / max) * CHART_HEIGHT),
                                    }}
                                />
                            </div>
                        </Tooltip>
                    );
                })}
            </div>
        </div>
    );
}

/**
 * The Agent status tab's speed report: the status-bar card's figures as tiles, and every retained response as a bar.
 */
export function AgentThroughputSection({
    throughput,
}: {
    throughput: AgentThroughput | null | undefined;
}) {
    const latest = throughput?.samples.at(-1);
    const lastResponseAgo = useRelativeTime(latest?.completedAt);
    if (!throughput || !latest)
        return (
            <ReportCard title="Output speed">
                <p className="m-0 text-[12px] text-muted">
                    {throughput === undefined
                        ? 'Reading the transcript…'
                        : 'No response has been measured yet. Speed appears after the Agent finishes its first response.'}
                </p>
            </ReportCard>
        );
    const recent = throughputRate(throughput.recent);
    const recentCount = throughput.recent.responseCount;
    return (
        <ReportCard
            title="Output speed"
            caption={`Average of the last ${recentCount === 1 ? 'response' : `${recentCount} responses`}: ${rateLabel(recent)}`}
        >
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2">
                <StatTile
                    label="Last response"
                    value={rateLabel(throughputRate(latest))}
                    detail={
                        <>
                            {describeThroughputSample(latest)}
                            {lastResponseAgo && (
                                <span className="whitespace-nowrap">, {lastResponseAgo}</span>
                            )}
                        </>
                    }
                />
                <StatTile
                    label="This turn"
                    value={rateLabel(throughputRate(throughput.turn))}
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
                            ? 'Not measured'
                            : formatThroughputDuration(throughput.turnTimeToFirstTokenMs)
                    }
                    detail="In the last finished turn"
                />
                <StatTile
                    label="Session"
                    value={rateLabel(throughputRate(throughput.session))}
                    detail={describeThroughputAggregate(throughput.session)}
                />
            </div>
            {throughput.samples.length > 1 && (
                <div className="mt-4">
                    <div className="mb-2 text-[11px] text-muted">
                        Last {throughput.samples.length} responses, oldest first; the dashed line is
                        the recent average
                    </div>
                    <ThroughputChart average={recent} samples={throughput.samples} />
                </div>
            )}
            <p className="mt-3 mb-0 text-[11px] leading-snug text-muted">
                {AGENT_THROUGHPUT_METHOD_NOTE}
            </p>
        </ReportCard>
    );
}
