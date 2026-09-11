import type {
    CommandExecutionContext,
    ServerOperationRequest,
    ServerRequest,
} from '@caxri/protocol';

import type { AgentEndpointRegistry } from './agent-endpoints/registry';
import { assertProjectScope } from './principal-project-scope';
import { dispatchIdFor } from './request-cancellation';

type AgentCommandRequest = Extract<
    ServerRequest,
    {
        method:
            | 'agent.delegation.presets'
            | 'agent.delegation.create'
            | 'agent.delegation.stop'
            | 'agent.delegation.status'
            | 'agent.delegation.result'
            | 'agent.delegation.wait'
            | 'agent.dispatch.start'
            | 'agent.dispatch.resume';
    }
>;

/**
 * Derives caller identity from the authenticated endpoint; public callers cannot supply authority.
 */
export function agentCommandRequest(
    request: AgentCommandRequest,
    context: CommandExecutionContext,
    requestId: string,
    endpoints: AgentEndpointRegistry,
): ServerOperationRequest {
    if (request.method === 'agent.dispatch.start' || request.method === 'agent.dispatch.resume') {
        assertProjectScope(context, request.params.projectId);
        const parameters = {
            dispatchId: dispatchIdFor(context, requestId),
            principal: context.principal,
            input: request.params,
        };
        return request.method === 'agent.dispatch.start'
            ? {
                  method: 'agent.dispatch.startInternal',
                  params: { ...parameters, input: request.params },
              }
            : {
                  method: 'agent.dispatch.resumeInternal',
                  params: { ...parameters, input: request.params },
              };
    }
    const authority = {
        principal: context.principal,
        callerTerminalId:
            context.principal.kind === 'agent'
                ? endpoints.context(context).endpoint.terminalId
                : undefined,
    };
    if (request.method === 'agent.delegation.create') {
        assertProjectScope(context, request.params.projectId);
        return {
            method: 'agent.delegation.createInternal',
            params: {
                ...authority,
                delegationId: dispatchIdFor(context, requestId),
                input: request.params,
            },
        };
    }
    if (request.method === 'agent.delegation.presets') {
        assertProjectScope(context, request.params.projectId);
        return {
            method: 'agent.delegation.presetsInternal',
            params: { ...authority, ...request.params },
        };
    }
    if (request.method === 'agent.delegation.stop')
        return {
            method: 'agent.delegation.stopInternal',
            params: { ...authority, ...request.params },
        };
    if (request.method === 'agent.delegation.wait')
        return {
            method: 'agent.delegation.waitInternal',
            params: { ...authority, ...request.params },
        };
    return {
        method:
            request.method === 'agent.delegation.status'
                ? 'agent.delegation.statusInternal'
                : 'agent.delegation.resultInternal',
        params: { ...authority, delegationId: request.params.delegationId },
    };
}
