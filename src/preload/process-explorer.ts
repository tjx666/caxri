import { contextBridge, ipcRenderer } from 'electron';

import { PROCESS_EXPLORER_CHANNELS } from '../shared/process-explorer-channels';
import type { ProcessExplorerBridge } from '../shared/process-explorer';

const bridge: ProcessExplorerBridge = {
    snapshot: () => ipcRenderer.invoke(PROCESS_EXPLORER_CHANNELS.snapshot),
    theme: () => ipcRenderer.invoke(PROCESS_EXPLORER_CHANNELS.theme),
};

contextBridge.exposeInMainWorld('processExplorer', bridge);
