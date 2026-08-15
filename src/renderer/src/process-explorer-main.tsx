import './styles/process-explorer.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ErrorBoundary } from './components/error-boundary';
import { ProcessExplorerRoot } from './features/process-explorer/process-explorer-root';
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
