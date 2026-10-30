import type { RecoveringEventClient } from '@caxri/client';
import { createRecoveringEventClient } from '@caxri/client';
import type { ServerClient, ServerSupervisionEvent } from '@caxri/client/supervise';
import type { ServerEvent } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import type { DesktopServerConnectionOptions } from './server-attachment';

/**
 * Builds the durable-event recovery client for a Desktop attachment. `start()` rejects when recovery fails, so the
 * attach path throws and the reconnect backoff loop retries instead of announcing a reconnect over unrecovered state.
 */
export function createDesktopEventClient(parameters: {
    connection?: { serverId: string; stateEpoch: string };
    currentClient(): ServerClient | undefined;
    disconnectedError(): Error;
    emit(event: ServerEvent): void;
    logger: DesktopServerConnectionOptions['logger'];
}): RecoveringEventClient {
    return createRecoveringEventClient({
        emit: (event) => parameters.emit(event),
        ...(parameters.connection && { identity: parameters.connection }),
        onError: (error) =>
            parameters.logger.write('error', logEventCatalog.serverConnection.eventRecoveryFailed, {
                fields: {
                    error: error instanceof Error ? error.message : 'Unknown recovery error',
                },
            }),
        // Resolved per call so recovery always targets the currently attached client
        // instead of a connection that has since been lost.
        recover: (afterCursor) => {
            const attached = parameters.currentClient();
            if (!attached) return Promise.reject(parameters.disconnectedError());
            const identity = attached.welcome.connection;
            return attached.request('events.recover', {
                afterCursor,
                ...(identity && {
                    serverId: identity.serverId,
                    stateEpoch: identity.stateEpoch,
                }),
            });
        },
    });
}

/**
 * The Renderer resync signal sent once a reconnect has recovered durable state.
 */
export function reconnectedEvent(payload: {
    attempt: number;
    downtimeMs: number;
    isHostReplaced: boolean;
}): ServerEvent {
    return { event: 'host.connectionChanged', payload: { status: 'reconnected', ...payload } };
}

/**
 * Projects a Server supervision lifecycle change onto the `runtime.status` event Renderers consume.
 */
export function runtimeStatusEvent(event: ServerSupervisionEvent): ServerEvent {
    return {
        event: 'runtime.status',
        payload: { status: event.status, restartCount: event.restartCount },
    };
}
