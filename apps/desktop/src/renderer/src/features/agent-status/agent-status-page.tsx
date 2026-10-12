import { agentProviderCatalog, agentStatusTabLabel } from '@caxri/protocol';

import { usePolledQuery } from '@/hooks/use-polled-query';

import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { useTerminal } from '../../stores/selectors';
import { AgentProviderStatusSection } from './agent-provider-status-section';
import { AgentThroughputSection } from './agent-throughput-section';
import { agentThroughputViewState } from './agent-throughput-state';
import { useAgentProviderStatus } from './use-agent-provider-status';

/**
 * Agent status tab for one Agent Terminal, opened from the status bar's output-speed chip or `Show Agent Status`: the
 * speed figures in full and the provider's public service status, so a slow Agent can be told apart from a provider
 * incident. The heading is the tab's own label, so the two never disagree on casing.
 */
export function AgentStatusPage({ terminalId }: { terminalId: string }) {
    const terminal = useTerminal(terminalId);
    // Same key and pace as the status-bar chip, so both read one cached result.
    const throughputQuery = usePolledQuery(
        'terminal.agentThroughput',
        { terminalId },
        { label: 'terminal.agentThroughput', intervalMs: 2_000, staleTime: 1_000, retry: false },
    );
    const throughput = throughputQuery.data;
    const provider = terminal?.provider ?? throughput?.provider;
    const providerStatusQuery = useAgentProviderStatus(provider);
    const agentName = provider ? agentProviderCatalog[provider].displayName : undefined;
    // A Terminal titled after its Agent would only repeat the heading's provider name.
    const subtitle = terminal
        ? terminal.title && terminal.title !== agentName
            ? terminal.title
            : undefined
        : 'This Terminal is no longer open; figures stop updating.';
    const state = agentThroughputViewState({
        data: throughput,
        isError: throughputQuery.isError,
        isTerminalOpen: Boolean(terminal),
    });
    return (
        <div data-agent-status-page className="h-full overflow-y-auto">
            <div className="mx-auto flex max-w-6xl flex-col gap-3 p-4">
                <div className="flex min-w-0 items-center gap-2">
                    {provider && <AgentIdentityIcon identity={provider} size={18} />}
                    <div className="min-w-0">
                        <h1 className="m-0 text-[15px] font-semibold">
                            {agentStatusTabLabel(agentName)}
                        </h1>
                        {subtitle && (
                            <p className="mt-0.5 mb-0 truncate text-[11px] text-muted">
                                {subtitle}
                            </p>
                        )}
                    </div>
                </div>
                <AgentThroughputSection
                    state={state}
                    onRetry={() => {
                        // eslint-disable-next-line no-void -- a failed retry surfaces through the same error state
                        void throughputQuery.refetch();
                    }}
                />
                {/* A closed Terminal with no measured response leaves the provider unknown: nothing to check. */}
                {provider && agentName && (
                    <AgentProviderStatusSection
                        agentName={agentName}
                        isError={providerStatusQuery.isError}
                        status={providerStatusQuery.data}
                        onRetry={() => {
                            // eslint-disable-next-line no-void -- a failed retry surfaces through the same error state
                            void providerStatusQuery.refetch();
                        }}
                    />
                )}
            </div>
        </div>
    );
}
