import './styles/process-explorer.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ErrorBoundary } from './components/error-boundary';
import { processExplorerLocaleFromSearch } from './features/process-explorer/process-explorer-locale';
import { ProcessExplorerRoot } from './features/process-explorer/process-explorer-root';
import { applyLanguagePreference, I18nProvider } from './i18n';
import { observeWindowActive } from './lib/window-active';
import { installRendererErrorReporter } from './renderer-error-reporter';

installRendererErrorReporter((kind) => globalThis.processExplorer.reportError(kind));
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
        applyLanguagePreference(await globalThis.processExplorer.language());
    } catch {
        // Keep the system language.
    }
}

globalThis.processExplorer.onLanguageChanged(applyLanguagePreference);
// eslint-disable-next-line no-void -- applyInitialLanguage() never rejects, and render must wait for it
void applyInitialLanguage().then(render);

function render(): void {
    createRoot(document.querySelector('#root')!).render(
        <StrictMode>
            <I18nProvider>
                <ErrorBoundary
                    titleKey="core.errorBoundary.processExplorer.title"
                    descriptionKey="core.errorBoundary.processExplorer.description"
                    reloadLabelKey="core.errorBoundary.processExplorer.reload"
                    logScope="Process Explorer"
                >
                    <ProcessExplorerRoot />
                </ErrorBoundary>
            </I18nProvider>
        </StrictMode>,
    );
}
