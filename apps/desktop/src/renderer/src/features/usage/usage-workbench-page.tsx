import { useState } from 'react';

import type { AgentProvider, UsageRange, UsageReport } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds, errorMessage } from '@caxri/protocol';
import { keepPreviousData } from '@tanstack/react-query';
import { ChartColumn, RefreshCw } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Empty, EmptyMedia, EmptyTitle } from '../../components/ui/empty';
import { Spinner } from '../../components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { usePolledQuery } from '../../hooks/use-polled-query';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import type { UsageMetric } from './usage-metrics';
import { formatDate } from './usage-metrics';
import { UsageSections } from './usage-sections';

const RANGES: ReadonlyArray<{ value: UsageRange; label: string }> = [
    { value: '7d', label: '7D' },
    { value: '30d', label: '30D' },
    { value: '90d', label: '90D' },
    { value: '365d', label: '1Y' },
    { value: 'all', label: 'All' },
];
const ALL_AGENTS = 'all';
type AgentFilter = AgentProvider | typeof ALL_AGENTS;
/**
 * The report rescans only transcripts whose size or mtime changed, so a refresh while the page is visible costs tens of
 * milliseconds; a minute keeps today's figures current during an active Session.
 */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * Read once: a report's day boundaries only need to match the zone the user saw when the page loaded.
 */
const LOCAL_TIME_ZONE = new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function rangeCaption(report: UsageReport): string {
    return report.rangeStart
        ? `${formatDate(report.rangeStart)} to ${formatDate(report.today)}`
        : `All time through ${formatDate(report.today)}`;
}

function UsageBody({ report, metric }: { report: UsageReport; metric: UsageMetric }) {
    if (report.coverage.agentSessions === 0)
        return (
            <Empty className="h-full">
                <EmptyMedia>
                    <ChartColumn aria-hidden="true" size={24} />
                </EmptyMedia>
                <EmptyTitle>No Agent usage yet</EmptyTitle>
                <p className="m-0 max-w-[420px] text-[12px] text-muted">
                    Start an Agent in a Session; its tokens, cost, and pull requests show up here.
                </p>
            </Empty>
        );
    return <UsageSections metric={metric} report={report} />;
}

/**
 * Usage Workbench tab: token usage, estimated API cost, Agent time, and delivery outcomes for Agent conversations
 * started in Caxri Sessions. Everything is computed by the Server from local transcripts; see `docs/usage.md`.
 */
export function UsageWorkbenchPage() {
    const [range, setRange] = useState<UsageRange>('30d');
    const [agent, setAgent] = useState<AgentFilter>(ALL_AGENTS);
    const [metric, setMetric] = useState<UsageMetric>('tokens');
    const query = usePolledQuery(
        'usage.report',
        { timeZone: LOCAL_TIME_ZONE, range, ...(agent !== ALL_AGENTS && { provider: agent }) },
        {
            label: 'Usage page report',
            intervalMs: REFRESH_INTERVAL_MS,
            placeholderData: keepPreviousData,
        },
    );
    const report = query.data;
    const retry = () => {
        // eslint-disable-next-line no-void -- a failed retry surfaces through the same error state.
        void query.refetch();
    };

    return (
        <div data-usage-page className="grid h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
            <div className="flex flex-wrap items-end justify-between gap-3 bg-surface pt-4 pr-4 pb-3 pl-4">
                <div className="min-w-0">
                    <h1 className="m-0 text-[15px] font-semibold">Usage</h1>
                    <p className="mt-1 mb-0 text-[11px] leading-[1.45] text-muted">
                        {report
                            ? rangeCaption(report)
                            : 'Tokens, estimated cost, and outcomes of Agents in Caxri Sessions'}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <ToggleGroup
                        aria-label="Agent"
                        value={[agent]}
                        onValueChange={(next: AgentFilter[]) => {
                            if (next[0]) setAgent(next[0]);
                        }}
                    >
                        <ToggleGroupItem value={ALL_AGENTS}>All Agents</ToggleGroupItem>
                        {agentProviderIds.map((provider) => (
                            <ToggleGroupItem
                                key={provider}
                                aria-label={agentProviderCatalog[provider].displayName}
                                value={provider}
                            >
                                <AgentIdentityIcon identity={provider} size={14} />
                            </ToggleGroupItem>
                        ))}
                    </ToggleGroup>
                    <ToggleGroup
                        aria-label="Activity metric"
                        value={[metric]}
                        onValueChange={(next: UsageMetric[]) => {
                            if (next[0]) setMetric(next[0]);
                        }}
                    >
                        <ToggleGroupItem value="tokens">Tokens</ToggleGroupItem>
                        <ToggleGroupItem value="cost">Cost</ToggleGroupItem>
                    </ToggleGroup>
                    <ToggleGroup
                        aria-label="Range"
                        value={[range]}
                        onValueChange={(next: UsageRange[]) => {
                            if (next[0]) setRange(next[0]);
                        }}
                    >
                        {RANGES.map((item) => (
                            <ToggleGroupItem key={item.value} value={item.value}>
                                {item.label}
                            </ToggleGroupItem>
                        ))}
                    </ToggleGroup>
                </div>
            </div>
            <div className="min-h-0 overflow-y-auto" aria-busy={query.isFetching}>
                {report ? (
                    <UsageBody metric={metric} report={report} />
                ) : query.isError ? (
                    <Empty className="h-full">
                        <EmptyTitle>Usage could not be loaded</EmptyTitle>
                        <p className="m-0 max-w-[420px] text-[12px] text-muted">
                            {errorMessage(query.error, 'The usage report failed.')}
                        </p>
                        <Button size="sm" variant="secondary" onClick={retry}>
                            <RefreshCw aria-hidden="true" size={12} />
                            Retry
                        </Button>
                    </Empty>
                ) : (
                    <Empty className="h-full">
                        <Spinner aria-hidden="true" />
                        <EmptyTitle>Reading Agent transcripts…</EmptyTitle>
                    </Empty>
                )}
            </div>
        </div>
    );
}
