import '@xterm/xterm/css/xterm.css';
import './styles/terminal-fonts.css';
import './styles/styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { QueryClientProvider } from '@tanstack/react-query';

import { App } from './app';
import { ErrorBoundary } from './components/error-boundary';
import { queryClient } from './queries/client';
import { installRendererErrorReporter } from './renderer-error-reporter';

installRendererErrorReporter((kind) => globalThis.caxri.reportError(kind));

createRoot(document.querySelector('#root')!).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <ErrorBoundary>
                <App />
            </ErrorBoundary>
        </QueryClientProvider>
    </StrictMode>,
);
