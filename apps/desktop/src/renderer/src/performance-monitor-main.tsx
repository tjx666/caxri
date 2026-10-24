import './styles/performance-monitor.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { PerformanceMonitorRoot } from './features/performance-monitor/performance-monitor-root';
import { processExplorerLocaleFromSearch } from './features/process-explorer/process-explorer-locale';
import { applyLanguagePreference } from './i18n';
import { applyCssTheme } from './lib/theme-css';
import { observeWindowActive } from './lib/window-active';
import { installRendererErrorReporter } from './renderer-error-reporter';
import { RendererRoot } from './renderer-root';

installRendererErrorReporter((kind) => globalThis.performanceMonitor.reportError(kind));
observeWindowActive();
// Before the first render, so the window opens in the Workbench's `workbench.language` instead of the system language.
applyLanguagePreference(processExplorerLocaleFromSearch(location.search));

/**
 * This window loads no Workbench snapshot, so the `workbench.language` setting comes over its own bridge: read once
 * before the first render, so the window never paints in the system language first, then on every settings change Main
 * relays. A failed read leaves the system language the locale store started from.
 */
async function applyInitialLanguage(): Promise<void> {
    try {
        applyLanguagePreference(await globalThis.performanceMonitor.language());
    } catch {
        // Keep the system language.
    }
}

globalThis.performanceMonitor.onLanguageChanged(applyLanguagePreference);
// eslint-disable-next-line no-void -- applyInitialLanguage() never rejects, and render must wait for it
void Promise.all([applyInitialLanguage(), applyInitialTheme()]).then(render);

/**
 * The monitor loads no Workbench snapshot, so the theme tokens come over the bridge before first paint; a failed read
 * leaves the stylesheet's fallbacks.
 */
async function applyInitialTheme(): Promise<void> {
    try {
        applyCssTheme(await globalThis.performanceMonitor.theme());
    } catch {
        // Keep the fallbacks.
    }
}

function render(): void {
    createRoot(document.querySelector('#root')!).render(
        <StrictMode>
            <RendererRoot
                withQuery={false}
                boundary={{
                    titleKey: 'core.errorBoundary.performanceMonitor.title',
                    descriptionKey: 'core.errorBoundary.performanceMonitor.description',
                    reloadLabelKey: 'core.errorBoundary.performanceMonitor.reload',
                    logScope: 'Performance Monitor',
                }}
            >
                <PerformanceMonitorRoot />
            </RendererRoot>
        </StrictMode>,
    );
}
