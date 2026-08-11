import './styles/process-explorer.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ErrorBoundary } from './components/ErrorBoundary';
import { ProcessExplorerApp } from './features/process-explorer/ProcessExplorerApp';

const forcedRenderErrorKey = 'caxri.process-explorer.forced-render-error';
const forceRenderError =
    new URLSearchParams(window.location.search).get('caxri-test-render-error') === '1' &&
    sessionStorage.getItem(forcedRenderErrorKey) !== 'consumed';
if (forceRenderError) sessionStorage.setItem(forcedRenderErrorKey, 'consumed');

function ProcessExplorerRoot() {
    /** The E2E-only query is consumed per document so the fallback's reload can recover. */
    if (forceRenderError) throw new Error('Forced Process Explorer render error');
    return <ProcessExplorerApp />;
}

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
