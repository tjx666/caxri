import type { CommandExecutionContext, ServerRequest } from '@caxri/protocol';

import type { AgentInboxRegistry } from './agent-inbox';

type AgentInboxRequest = Extract<
    ServerRequest,
    {
        method:
            | 'agent.message.wait'
            | 'agent.message.check'
            | 'agent.message.receipt'
            | 'agent.message.policy.get'
            | 'agent.message.policy.set'
            | 'agent.message.held'
            | 'agent.message.held.get'
            | 'agent.message.approve'
            | 'agent.message.deny';
    }
>;

/**
 * Answers the Agent inbox's own methods in Server Core: waiting for and checking messages, the receipt of a sent one,
 * the delivery policy, and the held messages the owner approves or denies. None of them reaches a domain service.
 */
export function agentInboxRequest(
    request: AgentInboxRequest,
    context: CommandExecutionContext,
    requestId: string,
    agentInbox: AgentInboxRegistry,
) {
    switch (request.method) {
        case 'agent.message.wait':
            return agentInbox.wait(context, request.params.timeoutMs, requestId);
        case 'agent.message.check':
            return agentInbox.check(context, requestId);
        case 'agent.message.receipt':
            return agentInbox.receipt(context, request.params.messageId);
        case 'agent.message.policy.get':
            return agentInbox.policy(context);
        case 'agent.message.policy.set':
            return agentInbox.setPolicy(context, request.params);
        case 'agent.message.held':
            return { messages: agentInbox.listHeld() };
        case 'agent.message.held.get':
            return agentInbox.heldDetail(request.params.messageId);
        case 'agent.message.approve':
            return agentInbox.approve(request.params.messageId);
        case 'agent.message.deny':
            return agentInbox.deny(request.params.messageId);
    }
}
