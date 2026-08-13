import { contextBridge, ipcRenderer } from 'electron';

import type { CaxriBridge, CaxriMethod, MethodReply, ParamsArg, RuntimeEvent } from '../shared/ipc';
import { createRecoveringEventClient } from '../shared/ipc/event-client';
import type { ProtocolEventEnvelope, TransientRuntimeEvent } from '../shared/ipc/event-journal';
import { fromWireError } from '../shared/ipc/errors';
import { CAXRI_PROTOCOL_VERSION, type ProtocolWelcome } from '../shared/ipc/version';

/**
 * Kept entry-local because sharing this constant across both preload entries makes Vite extract a
 * CommonJS chunk, which Electron's sandboxed preload loader cannot require.
 */
const rendererErrorChannel = 'caxri:renderer-error';

/**
 * Forwards a structured request and hands the reply envelope back untouched. Main answers with
 * `{ id, ok, result | error }` rather than throwing so the Caxri error code survives both the
 * Electron IPC hop and the `contextBridge` copy, which reduces a thrown error to its message and
 * stack.
 */
async function request<M extends CaxriMethod>(
    method: M,
    ...args: ParamsArg<M>
): Promise<MethodReply<M>> {
    /** The payload crosses a process boundary as unknown; the method table owns its static shape. */
    return (await ipcRenderer.invoke('caxri:request', {
        protocolVersion: CAXRI_PROTOCOL_VERSION,
        id: crypto.randomUUID(),
        method,
        params: args[0] ?? {},
    })) as MethodReply<M>;
}

const eventListeners = new Set<(event: RuntimeEvent) => void>();
const eventClient = createRecoveringEventClient({
    emit: (event) => {
        for (const listener of eventListeners) listener(event);
    },
    recover: async (afterCursor) => {
        const reply = await request('events.recover', { afterCursor });
        if (!reply.ok) throw fromWireError(reply.error);
        return reply.result;
    },
});
const eventHandler = (
    _event: Electron.IpcRendererEvent,
    message: ProtocolEventEnvelope | TransientRuntimeEvent,
): void => eventClient.receive(message);

const bridge: CaxriBridge = {
    negotiate: async () =>
        (await ipcRenderer.invoke('caxri:negotiate', {
            supportedVersions: [CAXRI_PROTOCOL_VERSION],
        })) as ProtocolWelcome,
    request,
    reportError: (kind) => ipcRenderer.send(rendererErrorChannel, kind),
    onEvent: (listener: (event: RuntimeEvent) => void): (() => void) => {
        eventListeners.add(listener);
        if (eventListeners.size === 1) {
            ipcRenderer.on('caxri:event', eventHandler);
            ipcRenderer.send('caxri:renderer-events-ready');
            void eventClient.start();
        }
        return () => {
            eventListeners.delete(listener);
            if (eventListeners.size === 0) ipcRenderer.removeListener('caxri:event', eventHandler);
        };
    },
};

contextBridge.exposeInMainWorld('caxri', bridge);
