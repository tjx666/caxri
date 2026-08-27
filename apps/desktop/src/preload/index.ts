import { createRecoveringEventClient } from '@caxri/client/state';
import type {
    CaxriBridge,
    CaxriMethod,
    MethodReply,
    ParametersArgument,
    ProtocolEventEnvelope,
    ProtocolWelcome,
    ServerEvent,
    TransientServerEvent,
} from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION, fromWireError } from '@caxri/protocol';
import { contextBridge, ipcRenderer } from 'electron';

/**
 * Kept entry-local because sharing this constant across both preload entries makes Vite extract a CommonJS chunk, which
 * Electron's sandboxed preload loader cannot require.
 */
const rendererErrorChannel = 'caxri:renderer-error';
/**
 * Kept entry-local for the same sandboxed-preload chunking reason as `rendererErrorChannel`; the browser-safe protocol
 * owns the matching payload schema and Main validates every report before logging it.
 */
const rendererDiagnosticChannel = 'caxri:renderer-diagnostic';
/**
 * Electron's sandbox exposes its limited `process` global but cannot load `node:process`; importing that module makes
 * the entire CommonJS preload fail before the bridge is installed.
 */
// eslint-disable-next-line n/prefer-global/process -- required by Electron's sandboxed preload runtime
const isE2E = process.env.CAXRI_E2E === '1';
const e2eRequestState = { sessionStateUpdateCount: 0 };

/**
 * Forwards a structured request and hands the reply envelope back untouched. Main answers with `{ id, ok, result |
 * error }` rather than throwing so the Caxri error code survives both the Electron IPC hop and the `contextBridge`
 * copy, which reduces a thrown error to its message and stack.
 */
async function requestWithId<M extends CaxriMethod>(
    requestId: string,
    method: M,
    ...arguments_: ParametersArgument<M>
): Promise<MethodReply<M>> {
    if (isE2E && method === 'session.updateState') e2eRequestState.sessionStateUpdateCount += 1;
    /**
     * The payload crosses a process boundary as unknown; the method table owns its static shape.
     */
    return (await ipcRenderer.invoke('caxri:request', {
        protocolVersion: CAXRI_PROTOCOL_VERSION,
        id: requestId,
        method,
        params: arguments_[0] ?? {},
    })) as MethodReply<M>;
}

async function request<M extends CaxriMethod>(
    method: M,
    ...arguments_: ParametersArgument<M>
): Promise<MethodReply<M>> {
    return requestWithId(crypto.randomUUID(), method, ...arguments_);
}

const eventListeners = new Set<(event: ServerEvent) => void>();
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
    message: ProtocolEventEnvelope | TransientServerEvent,
): void => eventClient.receive(message);

const bridge: CaxriBridge = {
    negotiate: async () =>
        (await ipcRenderer.invoke('caxri:negotiate', {
            supportedVersions: [CAXRI_PROTOCOL_VERSION],
        })) as ProtocolWelcome,
    request,
    requestWithId,
    reportDiagnostic: (diagnostic) => ipcRenderer.send(rendererDiagnosticChannel, diagnostic),
    reportError: (kind) => ipcRenderer.send(rendererErrorChannel, kind),
    onEvent: (listener: (event: ServerEvent) => void): (() => void) => {
        eventListeners.add(listener);
        if (eventListeners.size === 1) {
            ipcRenderer.on('caxri:event', eventHandler);
            ipcRenderer.send('caxri:renderer-events-ready');
            // `onEvent` must return its unsubscribe function synchronously, so starting the
            // recovery client here is deliberately fire-and-forget rather than awaited.
            // eslint-disable-next-line unicorn/prefer-await -- see comment above
            eventClient.start().catch(() => {});
        }
        return () => {
            eventListeners.delete(listener);
            if (eventListeners.size === 0) {
                ipcRenderer.removeListener('caxri:event', eventHandler);
                eventClient.stop();
            }
        };
    },
};

contextBridge.exposeInMainWorld('caxri', bridge);

if (isE2E) {
    /**
     * This narrow E2E-only seam counts the exact persistence request guarded by the pane-tab regression. It is not a
     * general IPC recorder and never exposes request arguments, replies, or production diagnostics.
     */
    contextBridge.exposeInMainWorld('caxriE2E', {
        resetSessionStateUpdateCount: () => {
            e2eRequestState.sessionStateUpdateCount = 0;
        },
        sessionStateUpdateCount: () => e2eRequestState.sessionStateUpdateCount,
    });
}
