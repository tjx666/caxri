// Keep first: arms opt-in react-scan render counting before react-dom evaluates (see electron.vite.config.ts).
import 'virtual:caxri-react-scan-boot';
import '@xterm/xterm/css/xterm.css';
import './styles/terminal-fonts.css';
import './styles/styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { QueryClientProvider } from '@tanstack/react-query';

import { App } from './app';
import { toastActionHandlers } from './commands/toast-actions';
import { ErrorBoundary } from './components/error-boundary';
import { WorkbenchI18nProvider } from './components/workbench-i18n-provider';
import { installRendererPerformanceMonitoring } from './features/renderer-performance/controller';
import { installStoreInspector } from './lib/store';
import { observeWindowActive } from './lib/window-active';
import { queryClient } from './queries/client';
import { installRendererErrorReporter } from './renderer-error-reporter';
import { configureToastActions } from './stores/toast-actions';

installRendererErrorReporter((kind) => globalThis.caxri.reportError(kind));
installRendererPerformanceMonitoring();
installStoreInspector();
observeWindowActive();
// Before the first render, because a notification raised during boot has to know what its button does the moment it is
// shown; the store that records notifications may not reach the feature modules that answer for them.
configureToastActions(toastActionHandlers);

createRoot(document.querySelector('#root')!).render(
    <StrictMode>
        <WorkbenchI18nProvider>
            <QueryClientProvider client={queryClient}>
                <ErrorBoundary>
                    <App />
                </ErrorBoundary>
            </QueryClientProvider>
        </WorkbenchI18nProvider>
    </StrictMode>,
);
