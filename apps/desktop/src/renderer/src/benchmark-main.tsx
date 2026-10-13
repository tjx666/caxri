// Keep first: arms opt-in react-scan render counting before react-dom evaluates (see electron.vite.config.ts).
import 'virtual:caxri-react-scan-boot';
import './styles/terminal-fonts.css';
import './styles/styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { QueryClientProvider } from '@tanstack/react-query';

import { ErrorBoundary } from './components/error-boundary';
import { BenchmarkApp } from './features/benchmark/benchmark-app';
import { I18nProvider } from './i18n';
import { installStoreInspector } from './lib/store';
import { observeWindowActive } from './lib/window-active';
import { queryClient } from './queries/client';
import { installRendererErrorReporter } from './renderer-error-reporter';
import { syncWorkbenchLocale } from './stores/workbench-locale';

installRendererErrorReporter((kind) => globalThis.caxri.reportError(kind));
installStoreInspector();
observeWindowActive();
syncWorkbenchLocale();

createRoot(document.querySelector('#root')!).render(
    <StrictMode>
        <I18nProvider>
            <QueryClientProvider client={queryClient}>
                <ErrorBoundary
                    titleKey="core.errorBoundary.benchmark.title"
                    descriptionKey="core.errorBoundary.benchmark.description"
                    reloadLabelKey="core.errorBoundary.benchmark.reload"
                    logScope="Benchmark"
                >
                    <BenchmarkApp />
                </ErrorBoundary>
            </QueryClientProvider>
        </I18nProvider>
    </StrictMode>,
);
