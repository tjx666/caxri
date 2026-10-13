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
            | 'agent.delegation.list'
            | 'agent.delegation.wait'
            | 'agent.dispatch.start'
            | 'agent.dispatch.resume';
    }
>;

/**
 * An Agent delegates into Sessions it creates in any Project the user added, so its own Project scope cannot decide the
 * target. Core defers that check to the delegation domain, which admits the caller's own Session and Sessions it
 * created in a visible top-level Project (`authorizeDelegationSession`). An external delegation identity stays bound to
 * its Project here.
 */
function assertDelegationTargetScope(context: CommandExecutionContext, projectId: string): void {
    if (context.principal.kind === 'agent') return;
    assertProjectScope(context, projectId);
}

/**
 * Resolves an Agent's `current` record query to the Project or Session of its own Endpoint, since an Agent has no
 * Workbench selection. Every other caller and mode passes through unchanged.
 */
export function agentCurrentQuery<Query extends { mode: string }>(
    query: Query,
    context: CommandExecutionContext,
    endpoints: AgentEndpointRegistry,
    field: 'projectId' | 'sessionId',
): Query | { mode: 'show'; selector: string } {
    if (context.principal.kind !== 'agent' || query.mode !== 'current') return query;
    return { mode: 'show', selector: endpoints.context(context).endpoint[field] };
}

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
        assertDelegationTargetScope(context, request.params.projectId);
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
        assertDelegationTargetScope(context, request.params.projectId);
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
    if (request.method === 'agent.delegation.list')
        return {
            method: 'agent.delegation.listInternal',
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
