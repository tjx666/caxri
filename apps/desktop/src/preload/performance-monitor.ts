import type { AppLocale, RENDERER_ERROR_CHANNELS, ThemeTokens } from '@caxri/protocol';
import { contextBridge, ipcRenderer } from 'electron';

import type { PerformanceMonitorWindowBridge } from '../shared/performance-monitor';
import { PERFORMANCE_MONITOR_CHANNELS } from '../shared/performance-monitor-channels';

/**
 * Kept as an entry-local literal for the same sandboxed-preload chunking reason as the Process Explorer preload.
 */
const rendererErrorChannel: (typeof RENDERER_ERROR_CHANNELS)['performanceMonitor'] =
    'caxri:performance-monitor:renderer-error';

/**
 * Subscribes to a Main push channel and returns the unsubscribe.
 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.off(channel, handler);
}

const bridge: PerformanceMonitorWindowBridge = {
    reportError: (kind) => ipcRenderer.send(rendererErrorChannel, kind),
    getState: () => ipcRenderer.invoke(PERFORMANCE_MONITOR_CHANNELS.getState),
    metrics: () => ipcRenderer.invoke(PERFORMANCE_MONITOR_CHANNELS.metrics),
    reload: ({ ignoreCache }) =>
        ipcRenderer.invoke(PERFORMANCE_MONITOR_CHANNELS.reload, ignoreCache),
    switchToOverlay: () => ipcRenderer.invoke(PERFORMANCE_MONITOR_CHANNELS.switchToOverlay),
    setAlwaysOnTop: (value) =>
        ipcRenderer.invoke(PERFORMANCE_MONITOR_CHANNELS.setAlwaysOnTop, value),
    theme: () => ipcRenderer.invoke(PERFORMANCE_MONITOR_CHANNELS.theme),
    onThemeChanged: (listener) =>
        subscribe<ThemeTokens>(PERFORMANCE_MONITOR_CHANNELS.themeChanged, listener),
    language: () => ipcRenderer.invoke(PERFORMANCE_MONITOR_CHANNELS.language),
    onLanguageChanged: (listener) =>
        subscribe<AppLocale | null>(PERFORMANCE_MONITOR_CHANNELS.languageChanged, listener),
    onSnapshot: (listener) => subscribe(PERFORMANCE_MONITOR_CHANNELS.snapshot, listener),
    onState: (listener) => subscribe(PERFORMANCE_MONITOR_CHANNELS.state, listener),
};

contextBridge.exposeInMainWorld('performanceMonitor', bridge);
