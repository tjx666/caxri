import type { CommandExecutionContext, ServerOperationRequest } from '@caxri/protocol';
import { CaxriError, getMethodSpec } from '@caxri/protocol';

import type { AgentEndpointRegistry } from './agent-endpoints/registry';
import { retireEndpointsForOperation } from './agent-endpoints/retire-for-operation';
import type { ServerDomainService } from './domain-service';
import type { MutationAdmission } from './mutation-admission';
import type { RequestCancellationRegistry } from './request-cancellation';
import { principalRequestKey } from './request-cancellation';

/**
 * Forwards a Server operation to the domain service: reads pass straight through, writes queue behind mutation
 * admission and retire the Agent endpoints they invalidate first.
 */
export function createDomainOperationForwarder(
    domainService: ServerDomainService,
    mutationAdmission: MutationAdmission,
    agentEndpoints: AgentEndpointRegistry,
): (request: ServerOperationRequest, signal?: AbortSignal) => Promise<unknown> {
    return async (request, signal) => {
        const spec = getMethodSpec(request.method);
        if (!spec) throw new CaxriError('VALIDATION', 'Unknown Runtime command');
        if (spec.effect === 'read')
            return domainService.forward(request.method, request.params, undefined, signal);
        return mutationAdmission.run(async () => {
            retireEndpointsForOperation(agentEndpoints, request);
            return domainService.forward(request.method, request.params, undefined, signal);
        });
    };
}

/**
 * Forwards a long wait that the caller's disconnect aborts, since nobody is left to read its answer.
 */
export function disconnectableForwarder(
    cancellations: RequestCancellationRegistry,
    forward: (request: ServerOperationRequest, signal?: AbortSignal) => Promise<unknown>,
): (
    context: CommandExecutionContext,
    requestId: string,
    request: ServerOperationRequest,
) => Promise<unknown> {
    return (context, requestId, request) =>
        cancellations.runDisconnectable(principalRequestKey(context, requestId), (signal) =>
            forward(request, signal),
        );
}
