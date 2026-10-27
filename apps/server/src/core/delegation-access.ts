import type {
    CommandExecutionContext,
    ServerOperationRequest,
    ServerRequest,
} from '@caxri/protocol';
import { CaxriError, delegationAccessInternalMethods } from '@caxri/protocol';

import type { DelegationAccessRegistry } from './delegation-access-registry';

type AccessRequest = Extract<
    ServerRequest,
    {
        method:
            | 'agent.delegation.access.create'
            | 'agent.delegation.access.list'
            | 'agent.delegation.access.revoke';
    }
>;

export function isDelegationAccessRequest(request: ServerRequest): request is AccessRequest {
    return [
        'agent.delegation.access.create',
        'agent.delegation.access.list',
        'agent.delegation.access.revoke',
    ].includes(request.method);
}

/**
 * Owner bootstrap is distinct from Renderer folder grants and never available to external clients themselves.
 */
export async function invokeDelegationAccess(
    request: AccessRequest,
    context: CommandExecutionContext,
    registry: DelegationAccessRegistry,
    forward: (request: ServerOperationRequest) => Promise<unknown>,
) {
    if (context.principal.kind !== 'human-cli')
        throw new CaxriError(
            'FORBIDDEN',
            'Delegation access requires the owner CLI; Desktop folder grants remain separate',
        );
    if (request.method === 'agent.delegation.access.list') return { clients: registry.list() };
    if (request.method === 'agent.delegation.access.revoke')
        return registry.revoke(request.params.clientId, request.params.generation);
    const binding = await forward({
        method: 'agent.delegation.access.bootstrap',
        params: request.params,
    });
    return registry.create(
        delegationAccessInternalMethods['agent.delegation.access.bootstrap'].result.parse(binding),
        request.params.ttlMs,
    );
}
