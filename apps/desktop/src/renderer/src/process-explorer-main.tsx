import './styles/process-explorer.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ErrorBoundary } from './components/error-boundary';
import { ProcessExplorerRoot } from './features/process-explorer/process-explorer-root';
import { I18nProvider } from './i18n';
import { observeWindowActive } from './lib/window-active';
import { installRendererErrorReporter } from './renderer-error-reporter';

installRendererErrorReporter((kind) => globalThis.processExplorer.reportError(kind));
observeWindowActive();

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
