import { useState } from 'react';

import type { AgentProvider, UsageRange, UsageReport, UsageScope } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds, errorMessage } from '@caxri/protocol';
import { ChartColumn, RefreshCw } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Empty, EmptyMedia, EmptyTitle } from '../../components/ui/empty';
import { Spinner } from '../../components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { Tooltip } from '../../components/ui/tooltip';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import type { UsageMetric } from './usage-metrics';
import {
    didUsageRefreshFail,
    formatDate,
    usageEmptyState,
    usageScanCaption,
} from './usage-metrics';
import { UsageSections } from './usage-sections';
import { useUsageReport } from './use-usage-report';

const RANGES: ReadonlyArray<{ value: UsageRange; label: string }> = [
    { value: '7d', label: '7D' },
    { value: '30d', label: '30D' },
    { value: '90d', label: '90D' },
    { value: '365d', label: '1Y' },
    { value: 'all', label: 'All' },
];
const SCOPES: ReadonlyArray<{ value: UsageScope; label: string; description: string }> = [
    { value: 'caxri', label: 'Caxri', description: 'Agents started in Caxri Sessions' },
    {
        value: 'all',
        label: 'This Mac',
        description: 'Every Agent conversation on this Mac, including ones run outside Caxri',
    },
];
const ALL_AGENTS = 'all';
type AgentFilter = AgentProvider | typeof ALL_AGENTS;

/**
 * Read once: a report's day boundaries only need to match the zone the user saw when the page loaded.
 */
const LOCAL_TIME_ZONE = new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * The date range plus the price basis: every dollar figure below is an API list-price estimate, not what a subscription
 * plan bills, and the page header is the one line every card sits under.
 */
function rangeCaption(report: UsageReport): string {
    const range = report.rangeStart
        ? `${formatDate(report.rangeStart)} to ${formatDate(report.today)}`
        : `All time through ${formatDate(report.today)}`;
    const scan = usageScanCaption(report);
    return `${range} · Costs are API list-price estimates${scan ? ` · ${scan}` : ''}`;
}

function UsageBody({
    report,
    metric,
    agent,
    onShowAllAgents,
}: {
    report: UsageReport;
    metric: UsageMetric;
    agent: AgentProvider | undefined;
    onShowAllAgents: () => void;
}) {
    const empty = usageEmptyState(report, agent);
    if (empty?.kind === 'scanning')
        return (
            <Empty className="h-full">
                <Spinner aria-hidden="true" />
                <EmptyTitle>Reading Agent transcripts on this Mac…</EmptyTitle>
            </Empty>
        );
    if (empty?.kind === 'agentFilter')
        return (
            <Empty className="h-full">
                <EmptyMedia>
                    <ChartColumn aria-hidden="true" size={24} />
                </EmptyMedia>
                <EmptyTitle>{empty.title}</EmptyTitle>
                <Button size="sm" variant="secondary" onClick={onShowAllAgents}>
                    Show all Agents
                </Button>
            </Empty>
        );
    if (empty?.kind === 'noUsage')
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
 * started in Caxri Sessions, or for every Agent conversation on this Mac. Everything is computed by the Server from
 * local transcripts; see `docs/usage.md`.
 */
export function UsageWorkbenchPage() {
    const [scope, setScope] = useState<UsageScope>('caxri');
    const [range, setRange] = useState<UsageRange>('30d');
    const [agent, setAgent] = useState<AgentFilter>(ALL_AGENTS);
    const [metric, setMetric] = useState<UsageMetric>('tokens');
    const query = useUsageReport({
        timeZone: LOCAL_TIME_ZONE,
        range,
        scope,
        ...(agent !== ALL_AGENTS && { provider: agent }),
    });
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
                        {didUsageRefreshFail(query) && (
                            <>
                                {' · '}
                                <span className="text-danger">Couldn&apos;t refresh</span>
                                {' · '}
                                <button
                                    type="button"
                                    className="cursor-pointer rounded-sm border-0 bg-transparent p-0 text-[11px] text-foreground underline-offset-2 hover:underline focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
                                    onClick={retry}
                                >
                                    Retry
                                </button>
                            </>
                        )}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <ToggleGroup
                        aria-label="Agent Sessions counted"
                        value={[scope]}
                        onValueChange={(next: UsageScope[]) => {
                            if (next[0]) setScope(next[0]);
                        }}
                    >
                        {SCOPES.map((item) => (
                            <Tooltip key={item.value} content={item.description}>
                                <ToggleGroupItem value={item.value}>{item.label}</ToggleGroupItem>
                            </Tooltip>
                        ))}
                    </ToggleGroup>
                    <ToggleGroup
                        aria-label="Agent"
                        value={[agent]}
                        onValueChange={(next: AgentFilter[]) => {
                            if (next[0]) setAgent(next[0]);
                        }}
                    >
                        <ToggleGroupItem value={ALL_AGENTS}>All Agents</ToggleGroupItem>
                        {agentProviderIds.map((provider) => (
                            <Tooltip
                                key={provider}
                                content={agentProviderCatalog[provider].displayName}
                            >
                                <ToggleGroupItem
                                    aria-label={agentProviderCatalog[provider].displayName}
                                    value={provider}
                                >
                                    <AgentIdentityIcon identity={provider} size={14} />
                                </ToggleGroupItem>
                            </Tooltip>
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
                    <UsageBody
                        agent={agent === ALL_AGENTS ? undefined : agent}
                        metric={metric}
                        report={report}
                        onShowAllAgents={() => setAgent(ALL_AGENTS)}
                    />
                ) : query.isError ? (
                    <Empty className="h-full">
                        <EmptyTitle className="text-danger">Usage could not be loaded</EmptyTitle>
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
