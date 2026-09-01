import type { AgentEndpointControl } from '../../domains/agent-endpoints';
import type { AgentEndpointRegistry } from './registry';

export function createAgentEndpointControl(registry: AgentEndpointRegistry): AgentEndpointControl {
    return {
        activate: (parameters) => Promise.resolve(registry.activate(parameters)),
        begin: (parameters) => Promise.resolve(registry.begin(parameters)),
        messaging: (parameters) => Promise.resolve(registry.updateMessaging(parameters)),
        retire: (parameters) => Promise.resolve(registry.retire(parameters)),
    };
}
