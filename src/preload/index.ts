import { contextBridge, ipcRenderer } from 'electron';

import type { CaxriBridge, CaxriMethod, RuntimeEvent } from '../shared/contracts';

const bridge: CaxriBridge = {
    request: async <T>(method: CaxriMethod, params: unknown = {}): Promise<T> => {
        return ipcRenderer.invoke('caxri:request', {
            id: crypto.randomUUID(),
            method,
            params,
        }) as Promise<T>;
    },
    onEvent: (listener: (event: RuntimeEvent) => void): (() => void) => {
        const handler = (_event: Electron.IpcRendererEvent, runtimeEvent: RuntimeEvent): void =>
            listener(runtimeEvent);
        ipcRenderer.on('caxri:event', handler);
        return () => ipcRenderer.removeListener('caxri:event', handler);
    },
};

contextBridge.exposeInMainWorld('caxri', bridge);
