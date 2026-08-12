import './styles/process-explorer.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ErrorBoundary } from './components/ErrorBoundary';
import { ProcessExplorerRoot } from './features/process-explorer/ProcessExplorerRoot';
import { installRendererErrorReporter } from './renderer-error-reporter';

installRendererErrorReporter((kind) => window.processExplorer.reportError(kind));

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <ErrorBoundary
            title="Process Explorer stopped rendering"
            description="Reload Process Explorer to resume live diagnostics."
            reloadLabel="Reload Process Explorer"
            logScope="Process Explorer"
        >
            <ProcessExplorerRoot />
        </ErrorBoundary>
    </StrictMode>,
);
