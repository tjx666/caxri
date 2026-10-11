import { agentProviderCatalog } from '@caxri/protocol';

import { usePolledQuery } from '@/hooks/use-polled-query';

import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { useTerminal } from '../../stores/selectors';
import { AgentProviderStatusSection } from './agent-provider-status-section';
import { AgentThroughputSection } from './agent-throughput-section';
import { useAgentProviderStatus } from './use-agent-provider-status';

/**
 * Agent status tab for one Agent Terminal, opened from the status bar's output-speed chip: the speed figures in full
 * and the provider's public service status, so a slow Agent can be told apart from a provider incident.
 */
export function AgentStatusPage({ terminalId }: { terminalId: string }) {
    const terminal = useTerminal(terminalId);
    // Same key and pace as the status-bar chip, so both read one cached result.
    const throughput = usePolledQuery(
        'terminal.agentThroughput',
        { terminalId },
        { label: 'terminal.agentThroughput', intervalMs: 2_000, staleTime: 1_000, retry: false },
    ).data;
    const provider = terminal?.provider ?? throughput?.provider;
    const providerStatus = useAgentProviderStatus(provider).data;
    const agentName = provider ? agentProviderCatalog[provider].displayName : 'Agent';
    return (
        <div data-agent-status-page className="h-full overflow-y-auto">
            <div className="flex flex-col gap-3 p-4">
                <div className="flex min-w-0 items-center gap-2">
                    {provider && <AgentIdentityIcon identity={provider} size={18} />}
                    <div className="min-w-0">
                        <h1 className="m-0 text-[15px] font-semibold">{agentName} status</h1>
                        <p className="mt-0.5 mb-0 truncate text-[11px] text-muted">
                            {terminal
                                ? terminal.title
                                : 'This Terminal is no longer open; figures stop updating.'}
                        </p>
                    </div>
                </div>
                <AgentThroughputSection throughput={throughput} />
                {/* A closed Terminal with no measured response leaves the provider unknown: nothing to check. */}
                {provider && (
                    <AgentProviderStatusSection agentName={agentName} status={providerStatus} />
                )}
            </div>
        </div>
    );
}
