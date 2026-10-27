import type { AgentEndpointRegistry } from './agent-endpoints';
import { AgentInboxRegistry } from './agent-inbox/registry';
import type { ControlServer } from './control-server';
import { ProviderMessagingAdapterRegistry } from './provider-messaging/registry';

/**
 * Connects messaging receipts to the current transport without capturing an uninitialized Server.
 */
export function createAgentMessaging(
    endpoints: AgentEndpointRegistry,
    server: () => ControlServer | undefined,
) {
    endpoints.onMessagingChanged((endpoint) => {
        const event = { event: 'agent.messaging.changed', payload: endpoint } as const;
        server()?.broadcastAgent(endpoint.ref, event);
        server()?.broadcastDesktop(event);
    });
    return {
        providerMessaging: new ProviderMessagingAdapterRegistry(endpoints),
        agentInbox: new AgentInboxRegistry(endpoints, {
            logger: endpoints.logger,
            emitHeld: (payload) =>
                server()?.broadcastDesktop({ event: 'agent.message.held', payload }),
            emitReceipt: (endpoint, payload) => {
                server()?.broadcastAgent(endpoint, { event: 'agent.message.receipt', payload });
                server()?.broadcastDesktop({ event: 'agent.message.receipt', payload });
            },
        }),
    };
}
