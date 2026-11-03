import type { RecoveringEventClient } from '@caxri/client/state';
import { createRecoveringEventClient } from '@caxri/client/state';
import type {
    CaxriEnvironmentBridge,
    CaxriMethod,
    MethodReply,
    ParametersArgument,
    ProtocolEventEnvelope,
    ServerEvent,
    TransientServerEvent,
} from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION, fromWireError } from '@caxri/protocol';

interface EnvironmentIpc {
    invoke(channel: string, ...arguments_: unknown[]): Promise<unknown>;
    on(channel: string, listener: (event: unknown, ...arguments_: unknown[]) => void): unknown;
    send(channel: string, ...arguments_: unknown[]): void;
}

/**
 * Electron channel Main sends SSH Host events on, as `(environmentId, message)`. Kept as a literal like the preload's
 * other channels, so the sandboxed preload never imports a shared runtime chunk.
 */
const ENVIRONMENT_EVENT_CHANNEL = 'caxri:environment-event';

/**
 * The preload half of {@link CaxriEnvironmentBridge}: one recovering event client per attached SSH Host, so one Host's
 * gap or slow recovery never replays or blocks another's events, and requests that carry the Host's id for Main to
 * route. An event for a Host that is not attached is dropped; attaching recovers its state from the Host's snapshot.
 */
export function createEnvironmentBridge(
    ipc: EnvironmentIpc,
    reportError: (error: unknown) => void,
): CaxriEnvironmentBridge {
    const listeners = new Set<(event: ServerEvent, environmentId: string) => void>();
    const clients = new Map<string, RecoveringEventClient>();
    let isListening = false;

    async function requestWithId<M extends CaxriMethod>(
        environmentId: string,
        requestId: string,
        method: M,
        ...arguments_: ParametersArgument<M>
    ): Promise<MethodReply<M>> {
        /**
         * The payload crosses a process boundary as unknown; the method table owns its static shape.
         */
        return (await ipc.invoke(
            'caxri:request',
            {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: requestId,
                method,
                params: arguments_[0] ?? {},
            },
            environmentId,
        )) as MethodReply<M>;
    }

    function emit(event: ServerEvent, environmentId: string): void {
        for (const listener of listeners)
            try {
                listener(event, environmentId);
            } catch (error) {
                // Never the payload: it may carry Terminal output or an Agent transcript.
                console.error(`[caxri] SSH Host event listener threw for "${event.event}"`, error);
            }
    }

    function listen(): void {
        if (isListening) return;
        isListening = true;
        ipc.on(ENVIRONMENT_EVENT_CHANNEL, (_event, environmentId, message) => {
            if (typeof environmentId !== 'string') return;
            clients
                .get(environmentId)
                ?.receive(message as ProtocolEventEnvelope | TransientServerEvent);
        });
    }

    return {
        requestWithId,
        attach(environmentId) {
            if (clients.has(environmentId)) return;
            listen();
            const client = createRecoveringEventClient({
                emit: (event) => emit(event, environmentId),
                recover: async (afterCursor) => {
                    const reply = await requestWithId(
                        environmentId,
                        crypto.randomUUID(),
                        'events.recover',
                        { afterCursor },
                    );
                    if (!reply.ok) throw fromWireError(reply.error);
                    return reply.result;
                },
                onError: reportError,
            });
            clients.set(environmentId, client);
            ipc.send('caxri:renderer-events-ready', environmentId);
            // `attach` is synchronous across the context bridge; the recovery reports its own failure.
            // eslint-disable-next-line unicorn/prefer-await -- see comment above
            client.start().catch(reportError);
        },
        detach(environmentId) {
            clients.get(environmentId)?.stop();
            clients.delete(environmentId);
        },
        onEvent(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
