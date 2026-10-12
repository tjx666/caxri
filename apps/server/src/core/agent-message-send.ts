import type { CommandExecutionContext, ServerRequest } from '@caxri/protocol';
import { CaxriError, hasRequiredCapabilities } from '@caxri/protocol';

import type { AgentEndpointRegistry } from './agent-endpoints/registry';
import type { AgentInboxRegistry } from './agent-inbox';
import type { ServerDomainService } from './domain-service';
import type { MutationAdmission } from './mutation-admission';
import { assertProjectScope } from './principal-project-scope';
import { dispatchIdFor } from './request-cancellation';

type AgentMessageSendParameters = Extract<
    ServerRequest,
    { method: 'agent.message.send' }
>['params'];

interface AgentMessageSendInput {
    agentEndpoints: AgentEndpointRegistry;
    agentInbox: AgentInboxRegistry;
    context: CommandExecutionContext;
    domainService: ServerDomainService;
    mutationAdmission: MutationAdmission;
    parameters: AgentMessageSendParameters;
    requestId: string;
}

/**
 * Sends an Agent message, waking a retired target first when the sender asks for it and holds an agent:control grant.
 */
export async function sendAgentMessage(input: AgentMessageSendInput): Promise<unknown> {
    const { agentEndpoints, agentInbox, context, domainService, parameters, requestId } = input;
    if (!parameters.wake) return agentInbox.send(context, parameters, requestId);
    if (!hasRequiredCapabilities(context, ['agents.dispatch', 'agents.control']))
        throw new CaxriError('FORBIDDEN', 'Waking an Agent requires an agent:control grant');
    let isTargetIsActive = true;
    try {
        agentEndpoints.resolve(parameters.to);
    } catch {
        isTargetIsActive = false;
    }
    if (isTargetIsActive) return agentInbox.send(context, parameters, requestId);
    /**
     * Only an exact bounded tombstone can be promoted into a wake dispatch.
     */
    const retired = agentEndpoints.resolveRetired(parameters.to);
    assertProjectScope(context, retired.projectId);
    input.mutationAdmission.begin();
    try {
        const dispatch = await domainService.request('agent.dispatch.wakeInternal', {
            dispatchId: dispatchIdFor(context, requestId),
            principal: context.principal,
            target: {
                projectId: retired.projectId,
                sessionId: retired.sessionId,
                terminalId: retired.terminalId,
            },
        });
        if (dispatch.status !== 'running' || !dispatch.endpoint)
            throw new CaxriError('UNAVAILABLE', 'Agent wake dispatch failed', {
                dispatchId: dispatch.dispatchId,
                status: dispatch.status,
            });
        const current = agentEndpoints.resolveTerminal(retired.terminalId);
        if (
            current.ref.endpointId !== dispatch.endpoint.endpointId ||
            current.ref.generation !== dispatch.endpoint.generation
        )
            throw new CaxriError('UNAVAILABLE', 'Agent generation changed after wake dispatch', {
                dispatchId: dispatch.dispatchId,
            });
        return agentInbox.send(
            context,
            {
                body: parameters.body,
                to: current.ref,
                ttlMs: parameters.ttlMs,
                ...(parameters.idempotencyKey && {
                    idempotencyKey: parameters.idempotencyKey,
                }),
            },
            requestId,
            dispatch.dispatchId,
        );
    } finally {
        input.mutationAdmission.finish();
    }
}
