import { contextBridge, ipcRenderer } from 'electron';

import type { CaxriBridge, CaxriMethod, MethodReply, ParamsArg, RuntimeEvent } from '../shared/ipc';

/**
 * Kept entry-local because sharing this constant across both preload entries makes Vite extract a
 * CommonJS chunk, which Electron's sandboxed preload loader cannot require.
 */
const rendererErrorChannel = 'caxri:renderer-error';

/**
 * Forwards a structured request and hands the reply envelope back untouched. Main answers with
 * `{ ok, result | error }` rather than throwing so the Caxri error code survives both the Electron
 * IPC hop and the `contextBridge` copy, which reduces a thrown error to its message and stack.
 */
async function request<M extends CaxriMethod>(
    method: M,
    ...args: ParamsArg<M>
): Promise<MethodReply<M>> {
    /** The payload crosses a process boundary as unknown; the method table owns its static shape. */
    return (await ipcRenderer.invoke('caxri:request', {
        id: crypto.randomUUID(),
        method,
        params: args[0] ?? {},
    })) as MethodReply<M>;
}

const bridge: CaxriBridge = {
    request,
    reportError: (kind) => ipcRenderer.send(rendererErrorChannel, kind),
    onEvent: (listener: (event: RuntimeEvent) => void): (() => void) => {
        const handler = (_event: Electron.IpcRendererEvent, runtimeEvent: RuntimeEvent): void =>
            listener(runtimeEvent);
        ipcRenderer.on('caxri:event', handler);
        return () => ipcRenderer.removeListener('caxri:event', handler);
    },
};

contextBridge.exposeInMainWorld('caxri', bridge);
