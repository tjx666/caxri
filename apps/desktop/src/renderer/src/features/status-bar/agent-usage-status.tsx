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

import { StructuredTooltip } from '../../components/structured-tooltip';
import { openEditorTab } from '../editor/document-commands';
import { agentUsageLabel, currentLimitWindows } from './agent-usage-label';
import { StatusItem } from './status-item';

const AGENT_USAGE_METHOD_NOTE =
    "Read from this conversation's own transcript and priced at API list prices, the same rules as the Usage page.";

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
 * Running tokens, estimated cost, and the latest rate-limit window of the conversation in the active Agent Terminal.
 * Clicking opens the Usage page. Renders nothing for a Shell or before the conversation records any usage, so it never
 * holds a slot to say "none".
 */
export function AgentUsageStatus({ terminalId }: { terminalId: string }) {
    const { data: readout, dataUpdatedAt } = usePolledQuery(
        'terminal.agentUsage',
        { terminalId },
        { label: 'terminal.agentUsage', intervalMs: 2_000, staleTime: 1_000, retry: false },
    );
    if (!readout) return null;
    // The poll time, not the render time, decides which limit windows have reset, keeping render pure.
    const now = dataUpdatedAt;
    const label = agentUsageLabel(readout, now);
    const agentName = agentProviderCatalog[readout.provider].displayName;
    const { tokens } = readout;
    const isPriced = readout.unpricedModels.length < readout.models.length;
    return (
        <StatusItem
            ariaLabel={`${agentName} conversation usage: ${label}`}
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
                            value: isPriced
                                ? formatUsd(readout.costUsd)
                                : 'No price for this model',
                        },
                        ...(isPriced && readout.unpricedModels.length > 0
                            ? [{ label: 'Unpriced', value: readout.unpricedModels.join(', ') }]
                            : []),
                        { label: 'Models', value: readout.models.join(', ') },
                        ...currentLimitWindows(readout.limit, now).map((window) => ({
                            label: `${formatLimitWindowName(window.windowMinutes)} limit`,
                            value: `${Math.round(window.usedPercent)}% used${window.resetsAt === undefined ? '' : ` · ${formatLimitReset(window.resetsAt, now)}`}`,
                        })),
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
