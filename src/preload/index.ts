import { contextBridge, ipcRenderer } from 'electron';

import type { CaxriBridge, CaxriMethod, MethodReply, ParamsArg, RuntimeEvent } from '../shared/ipc';

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
    onEvent: (listener: (event: RuntimeEvent) => void): (() => void) => {
        const handler = (_event: Electron.IpcRendererEvent, runtimeEvent: RuntimeEvent): void =>
            listener(runtimeEvent);
        ipcRenderer.on('caxri:event', handler);
        return () => ipcRenderer.removeListener('caxri:event', handler);
    },
};

contextBridge.exposeInMainWorld('caxri', bridge);
