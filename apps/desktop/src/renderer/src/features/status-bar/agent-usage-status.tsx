import type { AgentUsageReadout } from '@caxri/protocol';
import {
    agentProviderCatalog,
    formatLimitReset,
    formatLimitWindowName,
    formatTokens,
    formatUsd,
    usageTabPath,
} from '@caxri/protocol';
import { ChartColumn } from 'lucide-react';

import { usePolledQuery } from '@/hooks/use-polled-query';
import { useRelativeTime } from '@/hooks/use-relative-time';

import { StructuredTooltip } from '../../components/structured-tooltip';
import { openEditorTab } from '../editor/document-commands';
import { agentUsageCostLabel, agentUsageLabel, currentLimitWindows } from './agent-usage-label';
import { StatusItem } from './status-item';

const AGENT_USAGE_METHOD_NOTE =
    "Tokens and cost are read from this conversation's own transcript and priced at API list prices, the same rules as the Usage page. Plan limits are account-wide: the newest reading from any conversation.";

/**
 * `121k: 120k input, 900 output, 80k cache read`. Cache kinds the provider never reported are left out rather than
 * listed as zero.
 */
function describeTokens(tokens: AgentUsageReadout['tokens']): string {
    const parts = [`${formatTokens(tokens.input)} input`, `${formatTokens(tokens.output)} output`];
    if (tokens.cacheRead > 0) parts.push(`${formatTokens(tokens.cacheRead)} cache read`);
    if (tokens.cacheWrite > 0) parts.push(`${formatTokens(tokens.cacheWrite)} cache write`);
    return `${formatTokens(tokens.total)}: ${parts.join(', ')}`;
}

/**
 * Running tokens and estimated cost of the conversation in the active Agent Terminal, plus the newest account-wide
 * rate-limit window. Clicking opens the Usage page. Renders nothing for a Shell or before the conversation records any
 * usage, so it never holds a slot to say "none".
 */
export function AgentUsageStatus({ terminalId }: { terminalId: string }) {
    const { data: readout, dataUpdatedAt } = usePolledQuery(
        'terminal.agentUsage',
        { terminalId },
        { label: 'terminal.agentUsage', intervalMs: 2_000, staleTime: 1_000, retry: false },
    );
    const limitObservedAgo = useRelativeTime(readout?.limit?.observedAt);
    if (!readout) return null;
    // The poll time, not the render time, decides which limit windows have reset, keeping render pure.
    const now = dataUpdatedAt;
    const label = agentUsageLabel(readout, now);
    const agentName = agentProviderCatalog[readout.provider].displayName;
    const { tokens } = readout;
    const cost = agentUsageCostLabel(readout);
    const limitWindows = currentLimitWindows(readout.limit, now);
    return (
        <StatusItem
            ariaLabel={`Open Usage — ${agentName} conversation usage: ${label}`}
            className="statusbar-agent-usage"
            icon={<ChartColumn />}
            onClick={() => openEditorTab(usageTabPath())}
            title={
                <StructuredTooltip
                    eyebrow={`${agentName} conversation usage`}
                    title={label}
                    rows={[
                        { label: 'Tokens', value: describeTokens(tokens) },
                        {
                            label: 'Est. cost',
                            value: cost
                                ? `${formatUsd(readout.costUsd)}${readout.unpricedModels.length > 0 ? ' (partial)' : ''}`
                                : 'No price',
                        },
                        ...(cost && readout.unpricedModels.length > 0
                            ? [{ label: 'No price', value: readout.unpricedModels.join(', ') }]
                            : []),
                        { label: 'Models', value: readout.models.join(', ') },
                        ...limitWindows.map((window) => ({
                            label: `${formatLimitWindowName(window.windowMinutes)} limit`,
                            value: `${Math.round(window.usedPercent)}% used${window.resetsAt === undefined ? '' : ` · ${formatLimitReset(window.resetsAt, now)}`}`,
                        })),
                        ...(limitObservedAgo && limitWindows.length > 0
                            ? [{ label: 'Limits as of', value: limitObservedAgo }]
                            : []),
                    ]}
                    notes={[AGENT_USAGE_METHOD_NOTE]}
                    hint="Click to open Usage"
                />
            }
        >
            {label}
        </StatusItem>
    );
}
