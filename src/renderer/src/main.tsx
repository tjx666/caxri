import '@xterm/xterm/css/xterm.css';
import './styles/terminal-fonts.css';
import './styles/styles.css';

import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { queryClient } from './queries/client';
import { installRendererErrorReporter } from './renderer-error-reporter';

installRendererErrorReporter((kind) => window.caxri.reportError(kind));

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <ErrorBoundary>
                <App />
            </ErrorBoundary>
        </QueryClientProvider>
    </StrictMode>,
);
