import type { AgentProvider, AgentProviderSettings } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { AgentEndpointLifecycle } from '../agent-endpoints';
import type { CaxriDatabase } from '../db';
import type { AgentChatEndpoint } from './service-options';

/**
 * The Agent Endpoint every Chat process carries, so `caxri` commands from a Chat Agent authenticate as that Agent on
 * either surface. A PTY launch receives the same environment from the Terminal lifecycle; a Chat launch has no PTY
 * lifecycle, so the Chat service asks here instead. Caxri Bot's Chat keeps the `bot` role, matching the PTY launch.
 * Without an Endpoint, the CLI would fall back to the profile owner's identity, which the bundled skill forbids an
 * Agent to borrow, so a Chat Agent could not delegate at all.
 */
export function agentChatEndpoint({
    database,
    endpoints,
    providerSettings,
}: {
    database: Pick<CaxriDatabase, 'caxriBotRows' | 'getSession'>;
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
            if (!terminal.provider) return {};
            const session = database.getSession(terminal.sessionId);
            if (!session) throw new CaxriError('CONFLICT', 'Agent Chat Session no longer exists');
            return endpoints.environment(
                terminal,
                session.projectId,
                providerSettings(terminal.provider),
                launchId,
                database.caxriBotRows()?.terminalId === terminal.id ? 'bot' : undefined,
            );
        },
        retire: (terminalId) => endpoints.retire(terminalId),
    };
}
