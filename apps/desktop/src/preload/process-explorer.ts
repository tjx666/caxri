import type { AppLocale, RENDERER_ERROR_CHANNELS, ThemeTokens } from '@caxri/protocol';
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
    onThemeChanged: (listener) => {
        const handler = (_event: Electron.IpcRendererEvent, theme: ThemeTokens) => listener(theme);
        ipcRenderer.on(PROCESS_EXPLORER_CHANNELS.themeChanged, handler);
        return () => ipcRenderer.off(PROCESS_EXPLORER_CHANNELS.themeChanged, handler);
    },
    language: () => ipcRenderer.invoke(PROCESS_EXPLORER_CHANNELS.language),
    onLanguageChanged: (listener) => {
        const handler = (_event: Electron.IpcRendererEvent, preference: AppLocale | null) =>
            listener(preference);
        ipcRenderer.on(PROCESS_EXPLORER_CHANNELS.languageChanged, handler);
        return () => ipcRenderer.off(PROCESS_EXPLORER_CHANNELS.languageChanged, handler);
    },
};

contextBridge.exposeInMainWorld('processExplorer', bridge);
