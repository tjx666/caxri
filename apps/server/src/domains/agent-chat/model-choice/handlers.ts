import type { DomainHandlers } from '../../domain-services';
import type { AgentChatDefaultsService } from './chat-defaults';

/**
 * Settings' reads and writes of each Agent's global model default; see {@link AgentChatDefaultsService}.
 */
export function createAgentChatDefaultsHandlers(
    defaults: Pick<AgentChatDefaultsService, 'read' | 'write'>,
): Pick<DomainHandlers, 'agentChat.readDefaults' | 'agentChat.writeDefaults'> {
    return {
        'agentChat.readDefaults': ({ provider }) => defaults.read(provider),
        'agentChat.writeDefaults': ({ provider, ...change }) => defaults.write(provider, change),
    };
}
