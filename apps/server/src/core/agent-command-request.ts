import type {
    AgentSessionOperation,
    CommandExecutionContext,
    ServerOperationRequest,
    ServerRequest,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { AgentEndpointRegistry } from './agent-endpoints/registry';
import type { MobileAccessController } from './mobile/access-controller-contract';
import { assertProjectScope, projectScope } from './principal-project-scope';
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

type AgentControlRequest = Extract<
    ServerRequest,
    { method: 'agent.control.interrupt' | 'agent.control.stop' }
>;

/**
 * A paired device may interrupt an Agent it can reach but never stop its process; every caller stays inside the target
 * Endpoint's Project.
 */
export function agentControlRequest(
    request: AgentControlRequest,
    context: CommandExecutionContext,
    endpoints: AgentEndpointRegistry,
    mobileAccess: Pick<MobileAccessController, 'authorizePairedDeviceMethod'>,
): ServerOperationRequest {
    if (context.principal.kind === 'paired-device') {
        if (request.method !== 'agent.control.interrupt')
            throw new CaxriError('FORBIDDEN', 'Mobile device cannot stop Agent process');
        mobileAccess.authorizePairedDeviceMethod(context.principal, request.method);
    }
    const endpoint = endpoints.resolve(request.params.endpoint);
    assertProjectScope(context, endpoint.projectId);
    return {
        method:
            request.method === 'agent.control.interrupt'
                ? 'agent.control.interruptInternal'
                : 'agent.control.stopInternal',
        params: request.params,
    };
}

type AgentSessionRequest = Extract<
    ServerRequest,
    { method: 'agent.session.rename' | 'agent.session.archive' | 'agent.session.unarchive' }
>;

/**
 * Binds a Session management request to the caller's authenticated Terminal. Admission (which Sessions this caller
 * created) belongs to the session domain, so no Project scope is checked here: the target may sit in any Project the
 * user added, like the delegation that created it.
 */
export function agentSessionRequest(
    request: AgentSessionRequest,
    context: CommandExecutionContext,
    endpoints: AgentEndpointRegistry,
): ServerOperationRequest {
    if (context.principal.kind !== 'agent')
        throw new CaxriError('FORBIDDEN', 'Only an Agent manages the Sessions its Session created');
    const operation: AgentSessionOperation =
        request.method === 'agent.session.rename'
            ? { action: 'rename', title: request.params.title }
            : { action: request.method === 'agent.session.archive' ? 'archive' : 'unarchive' };
    return {
        method: 'agent.session.manageInternal',
        params: {
            principal: context.principal,
            callerTerminalId: endpoints.context(context).endpoint.terminalId,
            sessionId: request.params.sessionId,
            operation,
        },
    };
}

type SessionImportRequest = Extract<ServerRequest, { method: 'session.importConversation' }>;

/**
 * Binds a conversation import to the caller's Project scope. The owner's clients import anywhere, adding a Project when
 * none holds the folder; an Agent imports only into a Project it already works in, so "restore that conversation" from
 * its own Session works without widening its scope. Every other principal is refused.
 */
export function sessionImportRequest(
    request: SessionImportRequest,
    context: CommandExecutionContext,
): ServerOperationRequest {
    const { kind } = context.principal;
    if (kind !== 'desktop' && kind !== 'human-cli' && kind !== 'agent')
        throw new CaxriError('FORBIDDEN', 'Only the owner or an Agent imports a conversation');
    return {
        method: 'session.importConversationInternal',
        params: { ...request.params, projectScope: projectScope(context) },
    };
}

type AgentSecretRequest = Extract<
    ServerRequest,
    {
        method:
            | 'agent.secret.list'
            | 'agent.secret.request'
            | 'agent.secret.wait'
            | 'agent.secret.resolve';
    }
>;

/**
 * Binds a secret request to the Project and Terminal of the caller's authenticated Endpoint. An Agent never names the
 * Project whose secrets it reads, so it cannot reach another Project's secrets.
 */
export function agentSecretRequest(
    request: AgentSecretRequest,
    context: CommandExecutionContext,
    endpoints: AgentEndpointRegistry,
): ServerOperationRequest {
    if (context.principal.kind !== 'agent')
        throw new CaxriError('FORBIDDEN', 'Only an Agent running in Caxri uses Agent secrets');
    const { endpoint } = endpoints.context(context);
    const caller = { projectId: endpoint.projectId, terminalId: endpoint.terminalId };
    switch (request.method) {
        case 'agent.secret.list':
            return { method: 'agent.secret.listInternal', params: { caller } };
        case 'agent.secret.request':
            return {
                method: 'agent.secret.requestInternal',
                params: { ...request.params, caller },
            };
        case 'agent.secret.wait':
            return {
                method: 'agent.secret.waitInternal',
                params: { ...request.params, caller },
            };
        case 'agent.secret.resolve':
            return {
                method: 'agent.secret.resolveInternal',
                params: { ...request.params, caller },
            };
    }
}
