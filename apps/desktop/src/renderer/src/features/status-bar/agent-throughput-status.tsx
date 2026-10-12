import type { AgentProvider, AgentProviderStatus, AgentThroughputSample } from '@caxri/protocol';
import { agentProviderCatalog, agentStatusTabLabel } from '@caxri/protocol';
import { Gauge } from 'lucide-react';

import { usePolledQuery } from '@/hooks/use-polled-query';
import { useRelativeTime } from '@/hooks/use-relative-time';

import { StructuredTooltip } from '../../components/structured-tooltip';
import { useTerminal } from '../../stores/selectors';
import {
    describeProviderStatus,
    isProviderStatusDisrupted,
} from '../agent-status/agent-provider-status-label';
import { openAgentStatusTab } from '../agent-status/open-agent-status-tab';
import { ProviderStatusSummary } from '../agent-status/provider-status-summary';
import { useAgentProviderStatus } from '../agent-status/use-agent-provider-status';
import {
    AGENT_THROUGHPUT_METHOD_NOTE,
    describeThroughputAggregate,
    describeThroughputSample,
    formatThroughputDuration,
    formatThroughputRate,
    isSameThroughputAggregate,
    recentAverageLabel,
    spokenThroughputRate,
    throughputRate,
} from './agent-throughput-label';
import { StatusItem } from './status-item';

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
 * The chip before the Agent's first measured response, shown only while the provider's status page reports a problem: a
 * muted dash placeholder rate, so an incident is visible before the user's first prompt rather than only after a slow
 * answer.
 */
function UnmeasuredThroughputStatus({
    provider,
    status,
    terminalId,
}: {
    provider: AgentProvider;
    status: Extract<AgentProviderStatus, { state: 'available' }>;
    terminalId: string;
}) {
    const agentName = agentProviderCatalog[provider].displayName;
    const tabLabel = agentStatusTabLabel(agentName);
    return (
        <StatusItem
            ariaLabel={`Open ${tabLabel} — ${agentName} output speed: not measured yet; API status: ${describeProviderStatus(status)}`}
            className="statusbar-agent-throughput text-muted [&>span]:min-w-[8ch]"
            icon={<Gauge />}
            onClick={() => openAgentStatusTab(terminalId)}
            title={
                <StructuredTooltip
                    eyebrow={`${agentName} output speed`}
                    title="Not measured yet"
                    details={['Shown because the provider reports a problem']}
                    rows={[
                        { label: 'API status', value: <ProviderStatusSummary status={status} /> },
                    ]}
                    notes={[AGENT_THROUGHPUT_METHOD_NOTE]}
                    hint={`Click to open ${tabLabel}`}
                />
            }
        >
            —
        </StatusItem>
    );
}

/**
 * Output speed of the Agent in the active Terminal, measured from the provider's own transcript, with the provider's
 * public service status beside it so a slow Agent can be told apart from a provider incident. Clicking opens the
 * Terminal's Agent status tab, the same tab `Show Agent Status` opens. Renders nothing for a Shell or an unsupported
 * provider. Before the first measured response it renders nothing either, unless the provider's status page reports a
 * problem (`UnmeasuredThroughputStatus`), so it never holds a slot to say "none".
 */
export function AgentThroughputStatus({ terminalId }: { terminalId: string }) {
    const throughputQuery = usePolledQuery(
        'terminal.agentThroughput',
        { terminalId },
        { label: 'terminal.agentThroughput', intervalMs: 2_000, staleTime: 1_000, retry: false },
    );
    const throughput = throughputQuery.data;
    // The transcript names the provider once it exists; until then the Terminal record does.
    const terminalProvider = useTerminal(terminalId)?.provider;
    const provider = throughput?.provider ?? terminalProvider;
    const providerStatusQuery = useAgentProviderStatus(provider);
    const providerStatus = providerStatusQuery.data;
    const latest = throughput?.samples.at(-1);
    const lastResponseAgo = useRelativeTime(latest?.completedAt);
    const rate = throughput ? throughputRate(throughput.recent) : undefined;
    if (!throughput || !latest || rate === undefined) {
        if (!provider || providerStatus?.state !== 'available') return null;
        if (!isProviderStatusDisrupted(providerStatus)) return null;
        return (
            <UnmeasuredThroughputStatus
                provider={provider}
                status={providerStatus}
                terminalId={terminalId}
            />
        );
    }
    const label = formatThroughputRate(rate);
    const agentName = agentProviderCatalog[throughput.provider].displayName;
    const tabLabel = agentStatusTabLabel(agentName);
    const averageLabel = recentAverageLabel(throughput.recent.responseCount);
    // The first turn of an Agent Session is the whole Agent Session: two identical rows read as two different facts.
    const isShowTurn =
        throughput.turn.responseCount > 0 &&
        !isSameThroughputAggregate(throughput.turn, throughput.session);
    return (
        <StatusItem
            ariaLabel={`Open ${tabLabel} — ${agentName} output speed: ${spokenThroughputRate(rate)}, ${averageLabel.toLowerCase()}`}
            className="statusbar-agent-throughput [&>span]:min-w-[8ch]"
            icon={<Gauge />}
            onClick={() => openAgentStatusTab(terminalId)}
            title={
                <StructuredTooltip
                    eyebrow={`${agentName} output speed`}
                    title={label}
                    details={[averageLabel]}
                    rows={[
                        {
                            label: 'Last response',
                            value: (
                                <>
                                    {describeThroughputSample(latest)}
                                    {/* Kept on one line: `1 minute ago` split across two lines read as two facts. */}
                                    {lastResponseAgo && (
                                        <span className="whitespace-nowrap">
                                            , {lastResponseAgo}
                                        </span>
                                    )}
                                </>
                            ),
                        },
                        ...(isShowTurn
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
                            label: 'Agent Session',
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
                        // Null means the provider publishes no status page; the row is left out rather than saying so.
                        ...(providerStatus === null
                            ? []
                            : [
                                  {
                                      label: 'API status',
                                      value: (
                                          <ProviderStatusSummary
                                              isError={providerStatusQuery.isError}
                                              status={providerStatus}
                                          />
                                      ),
                                  },
                              ]),
                    ]}
                    notes={[AGENT_THROUGHPUT_METHOD_NOTE]}
                    hint={`Click to open ${tabLabel}`}
                />
            }
        >
            {label}
        </StatusItem>
    );
}
