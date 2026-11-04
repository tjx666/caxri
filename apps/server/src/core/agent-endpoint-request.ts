import type { CommandExecutionContext, ServerRequest } from '@caxri/protocol';

import type { AgentEndpointRegistry } from './agent-endpoints/registry';

type AgentEndpointRequest = Extract<
    ServerRequest,
    { method: 'agent.context' | 'agent.list' | 'agent.grants' | 'agent.grant' | 'agent.revoke' }
>;

/**
 * Answers the Agent Endpoint registry's own methods in Server Core: the caller's context, the live Agents, and the
 * grants between them. None of them reaches a domain service.
 */
export function agentEndpointRequest(
    request: AgentEndpointRequest,
    context: CommandExecutionContext,
    endpoints: AgentEndpointRegistry,
) {
    switch (request.method) {
        case 'agent.context':
            return endpoints.context(context);
        case 'agent.list':
            return { agents: endpoints.list(context) };
        case 'agent.grants':
            return { grants: endpoints.grants(request.params.endpoint) };
        case 'agent.grant':
            return endpoints.grant(
                request.params.endpoint,
                request.params.policy,
                request.params.ttlMs,
            );
        case 'agent.revoke':
            return {
                revoked: endpoints.revoke(request.params.endpoint, request.params.grantId),
            };
    }
}
