import type { AgentThroughputSample } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';
import { Timer } from 'lucide-react';

import { usePolledQuery } from '@/hooks/use-polled-query';
import { useRelativeTime } from '@/hooks/use-relative-time';

import { StructuredTooltip } from '../../components/structured-tooltip';
import {
    AGENT_THROUGHPUT_METHOD_NOTE,
    describeThroughputAggregate,
    describeThroughputSample,
    formatThroughputDuration,
    formatThroughputRate,
    throughputRate,
} from './agent-throughput-label';
import { StatusInfo } from './status-info';

const BAR_WIDTH = 4;
const BAR_GAP = 2;
const CHART_HEIGHT = 24;

/**
 * Per-response rates, oldest to newest, on a zero-based scale whose top is labelled so the bars read as values rather
 * than as a shape. The newest bar is drawn in the foreground ink; the rest stay muted.
 */
function ThroughputBars({ samples }: { samples: readonly AgentThroughputSample[] }) {
    const rates = samples.map((sample) => throughputRate(sample) ?? 0);
    const max = Math.max(...rates);
    if (max <= 0) return null;
    const width = rates.length * (BAR_WIDTH + BAR_GAP) - BAR_GAP;
    return (
        <span className="flex items-end gap-1.5">
            <svg
                aria-hidden="true"
                className="flex-none"
                height={CHART_HEIGHT}
                viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
                width={width}
            >
                {samples.map((sample, index) => {
                    const height = Math.max(1, (rates[index] / max) * CHART_HEIGHT);
                    return (
                        <rect
                            key={`${sample.completedAt}:${index}`}
                            className={
                                index === rates.length - 1 ? 'fill-foreground' : 'fill-muted'
                            }
                            height={height}
                            rx={1}
                            width={BAR_WIDTH}
                            x={index * (BAR_WIDTH + BAR_GAP)}
                            y={CHART_HEIGHT - height}
                        />
                    );
                })}
            </svg>
            <span className="text-muted tabular-nums">max {formatThroughputRate(max)}</span>
        </span>
    );
}

/**
 * Output speed of the Agent in the active Terminal, measured from the provider's own transcript. Renders nothing for a
 * Shell, an unsupported provider, or before the first measured response, so it never holds a slot to say "none".
 */
export function AgentThroughputStatus({ terminalId }: { terminalId: string }) {
    const throughput = usePolledQuery(
        'terminal.agentThroughput',
        { terminalId },
        { label: 'terminal.agentThroughput', intervalMs: 2_000, staleTime: 1_000, retry: false },
    ).data;
    const latest = throughput?.samples.at(-1);
    const lastResponseAgo = useRelativeTime(latest?.completedAt);
    const rate = throughput ? throughputRate(throughput.recent) : undefined;
    if (!throughput || !latest || rate === undefined) return null;
    const label = formatThroughputRate(rate);
    const agentName = agentProviderCatalog[throughput.provider].displayName;
    const recentCount = throughput.recent.responseCount;
    const recentLabel =
        recentCount === 1 ? 'the last response' : `the last ${recentCount} responses`;
    return (
        <StatusInfo
            ariaLabel={`${agentName} output speed: ${label} over ${recentLabel}`}
            className="statusbar-agent-throughput"
            icon={<Timer />}
            title={
                <StructuredTooltip
                    eyebrow={`${agentName} output speed`}
                    title={`${label} over ${recentLabel}`}
                    rows={[
                        {
                            label: 'Last response',
                            value: `${describeThroughputSample(latest)}${lastResponseAgo ? `, ${lastResponseAgo}` : ''}`,
                        },
                        ...(throughput.turn.responseCount > 0
                            ? [
                                  {
                                      label: 'This turn',
                                      value: describeThroughputAggregate(throughput.turn),
                                  },
                              ]
                            : []),
                        ...(throughput.turnTimeToFirstTokenMs === undefined
                            ? []
                            : [
                                  {
                                      label: 'First token',
                                      value: `${formatThroughputDuration(throughput.turnTimeToFirstTokenMs)} in the last finished turn`,
                                  },
                              ]),
                        {
                            label: 'Session',
                            value: describeThroughputAggregate(throughput.session),
                        },
                        ...(throughput.samples.length > 1
                            ? [
                                  {
                                      label: `Last ${throughput.samples.length}`,
                                      value: <ThroughputBars samples={throughput.samples} />,
                                  },
                              ]
                            : []),
                    ]}
                    notes={[AGENT_THROUGHPUT_METHOD_NOTE]}
                />
            }
        >
            {label}
        </StatusInfo>
    );
}
