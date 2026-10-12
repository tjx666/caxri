import type { AgentProvider, AgentProviderSettings } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { AgentChatEndpoint } from '../agent-chat';
import type { AgentEndpointLifecycle } from '../agent-endpoints';
import type { CaxriDatabase } from '../db';

/**
 * The Agent Endpoint a Chat Commander carries. The Commander does all its work through `"$CAXRI_CLI" ...` with the
 * `commander` role, which a PTY launch receives from the Terminal lifecycle environment. A Chat launch has no PTY
 * lifecycle, so the Chat service asks here instead, and only the recorded Commander Terminal gets an Endpoint: every
 * other Chat keeps running without one, as before.
 */
export function commanderChatEndpoint({
    database,
    endpoints,
    providerSettings,
}: {
    database: Pick<CaxriDatabase, 'agentCommanderRows' | 'getSession'>;
    endpoints: Pick<
        AgentEndpointLifecycle,
        'activate' | 'environment' | 'preparedEndpointForTerminal' | 'retire'
    >;
    providerSettings: (provider: AgentProvider) => AgentProviderSettings;
}): AgentChatEndpoint {
    return {
        activate: async (terminalId) => {
            if (endpoints.preparedEndpointForTerminal(terminalId))
                await endpoints.activate(terminalId);
        },
        environment: async (terminal, launchId) => {
            if (database.agentCommanderRows()?.terminalId !== terminal.id) return {};
            const session = database.getSession(terminal.sessionId);
            if (!session || !terminal.provider)
                throw new CaxriError('CONFLICT', 'Agent Commander Session no longer exists');
            return endpoints.environment(
                terminal,
                session.projectId,
                providerSettings(terminal.provider),
                launchId,
                'commander',
            );
        },
        retire: (terminalId) => endpoints.retire(terminalId),
    };
}
