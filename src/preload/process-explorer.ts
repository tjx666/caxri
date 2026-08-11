import { contextBridge, ipcRenderer } from 'electron';

import { PROCESS_EXPLORER_CHANNELS } from '../shared/process-explorer-channels';
import type { ProcessExplorerBridge } from '../shared/process-explorer';

/**
 * Kept entry-local because sharing this constant across both preload entries makes Vite extract a
 * CommonJS chunk, which Electron's sandboxed preload loader cannot require.
 */
const rendererErrorChannel = 'caxri:process-explorer:renderer-error';

const bridge: ProcessExplorerBridge = {
    reportError: (kind) => ipcRenderer.send(rendererErrorChannel, kind),
    snapshot: () => ipcRenderer.invoke(PROCESS_EXPLORER_CHANNELS.snapshot),
    theme: () => ipcRenderer.invoke(PROCESS_EXPLORER_CHANNELS.theme),
};

contextBridge.exposeInMainWorld('processExplorer', bridge);
