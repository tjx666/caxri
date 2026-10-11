import type { RENDERER_ERROR_CHANNELS } from '@caxri/protocol';
import { contextBridge, ipcRenderer } from 'electron';

import type { ProcessExplorerBridge } from '../shared/process-explorer';
import { PROCESS_EXPLORER_CHANNELS } from '../shared/process-explorer-channels';

/**
 * Kept as an entry-local literal: importing the protocol constant at runtime from both preload entries makes Rolldown
 * extract a shared CommonJS chunk, which Electron's sandboxed preload loader cannot require. The type-only binding
 * keeps the literal in lockstep with the protocol owner.
 */
const rendererErrorChannel: (typeof RENDERER_ERROR_CHANNELS)['processExplorer'] =
    'caxri:process-explorer:renderer-error';

const bridge: ProcessExplorerBridge = {
    reportError: (kind) => ipcRenderer.send(rendererErrorChannel, kind),
    snapshot: () => ipcRenderer.invoke(PROCESS_EXPLORER_CHANNELS.snapshot),
    stopTerminal: (terminalId) =>
        ipcRenderer.invoke(PROCESS_EXPLORER_CHANNELS.stopTerminal, terminalId),
    theme: () => ipcRenderer.invoke(PROCESS_EXPLORER_CHANNELS.theme),
};

contextBridge.exposeInMainWorld('processExplorer', bridge);
