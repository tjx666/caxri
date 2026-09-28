import { contextBridge, ipcRenderer } from 'electron';

import type { ProcessExplorerBridge } from '../shared/process-explorer';
import { PROCESS_EXPLORER_CHANNELS } from '../shared/process-explorer-channels';

/**
 * Kept entry-local because sharing this constant across both preload entries makes Vite extract a CommonJS chunk, which
 * Electron's sandboxed preload loader cannot require.
 */
const rendererErrorChannel = 'caxri:process-explorer:renderer-error';

const bridge: ProcessExplorerBridge = {
    reportError: (kind) => ipcRenderer.send(rendererErrorChannel, kind),
    snapshot: () => ipcRenderer.invoke(PROCESS_EXPLORER_CHANNELS.snapshot),
    stopTerminal: (terminalId) =>
        ipcRenderer.invoke(PROCESS_EXPLORER_CHANNELS.stopTerminal, terminalId),
    theme: () => ipcRenderer.invoke(PROCESS_EXPLORER_CHANNELS.theme),
};

contextBridge.exposeInMainWorld('processExplorer', bridge);
