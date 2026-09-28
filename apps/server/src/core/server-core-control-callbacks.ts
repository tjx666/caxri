import type { CommandExecutionContext } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { AgentEndpointRegistry } from './agent-endpoints/registry';
import type { AgentInboxRegistry } from './agent-inbox/registry';
import type { ControlServerOptions } from './control-server-support';
import type { openDelegationAccess } from './delegation-access';
import type { ServerDomainService } from './domain-service';
import type { RequestCancellationRegistry } from './request-cancellation';
import { principalRequestKey } from './request-cancellation';

/**
 * Mutable box for the `setImmediate` handle a `host.stop` command arms, so `onReplyFlushed` can clear it once the
 * matching reply actually flushes. Plain outer `let` would work too, but this factory lives outside `startServerCore`,
 * so the handle needs a reference both sides can share.
 */
export interface CommandStopFallbackReference {
    current: NodeJS.Immediate | undefined;
}

export interface ServerCoreControlCallbacksDependencies {
    agentEndpoints: AgentEndpointRegistry;
    agentInbox: AgentInboxRegistry;
    commandStopFallbackReference: CommandStopFallbackReference;
    delegationAccess: Awaited<ReturnType<typeof openDelegationAccess>>;
    dispatchWaitIds: Map<string, Set<string>>;
    domainService: ServerDomainService;
    logger: StructuredLogger;
    requestCancellations: RequestCancellationRegistry;
    stop: (reason?: string) => Promise<void>;
}

/**
 * `ControlServer` lifecycle callbacks that outlive one command: agent-message wait/reply bookkeeping, the `host.stop`
 * confirmation that finally exits, disconnect cleanup, and paired-device/delegation context refresh. Kept apart from
 * `startServerCore`'s per-request `invoke` dispatch, which owns command routing rather than transport lifecycle.
 */
export function createServerCoreControlCallbacks(
    dependencies: ServerCoreControlCallbacksDependencies,
): Pick<
    ControlServerOptions,
    'onDesktopUnavailable' | 'onReplyFlushed' | 'onRequestDisconnected' | 'refreshContext'
> {
    return {
        onDesktopUnavailable: async () => {
            try {
                await dependencies.domainService.request('terminal.detachAll');
            } catch {
                // Best-effort detach: domain services already report Desktop as unavailable.
            }
        },
        onReplyFlushed: async (request, reply, context) => {
            if (
                request.method === 'agent.message.wait' ||
                request.method === 'agent.message.check'
            ) {
                if (reply.ok) dependencies.agentInbox.confirmWait(request.id, context);
                else dependencies.agentInbox.cancelWait(request.id);
            }
            if (request.method === 'host.stop' && reply.ok) {
                if (dependencies.commandStopFallbackReference.current)
                    clearImmediate(dependencies.commandStopFallbackReference.current);
                dependencies.commandStopFallbackReference.current = undefined;
                try {
                    await dependencies.stop('command');
                } catch (error) {
                    dependencies.logger.write('error', logEventCatalog.serverCore.stopFailed, {
                        fields: { message: error instanceof Error ? error.message : String(error) },
                    });
                }
            }
        },
        onRequestDisconnected: async (requestId, context) => {
            dependencies.agentInbox.cancelWait(requestId);
            const key = principalRequestKey(context, requestId);
            dependencies.requestCancellations.disconnect(key);
            const waitIds = dependencies.dispatchWaitIds.get(key) ?? new Set<string>();
            await Promise.all(
                [...waitIds].map(async (waitId) => {
                    try {
                        await dependencies.domainService.request(
                            'agent.dispatch.cancelWaitInternal',
                            {
                                waitId,
                            },
                        );
                    } catch {
                        // Best-effort cancel: the wait may have already resolved.
                    }
                }),
            );
        },
        refreshContext: (context: CommandExecutionContext) =>
            context.principal.kind === 'delegation-client'
                ? dependencies.delegationAccess.refresh(context.principal)
                : dependencies.agentEndpoints.refresh(context),
    };
}
