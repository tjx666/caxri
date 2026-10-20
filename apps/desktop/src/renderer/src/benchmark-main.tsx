// Keep first: arms opt-in react-scan render counting before react-dom evaluates (see electron.vite.config.ts).
import 'virtual:caxri-react-scan-boot';
import './styles/terminal-fonts.css';
import './styles/styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { BenchmarkApp } from './features/benchmark/benchmark-app';
import { installStoreInspector } from './lib/store';
import { observeWindowActive } from './lib/window-active';
import { installRendererErrorReporter } from './renderer-error-reporter';
import { RendererRoot } from './renderer-root';
import { syncWorkbenchLocale } from './stores/workbench-locale';

installRendererErrorReporter((kind) => globalThis.caxri.reportError(kind));
installStoreInspector();
observeWindowActive();
syncWorkbenchLocale();

createRoot(document.querySelector('#root')!).render(
    <StrictMode>
        <RendererRoot
            boundary={{
                titleKey: 'core.errorBoundary.benchmark.title',
                descriptionKey: 'core.errorBoundary.benchmark.description',
                reloadLabelKey: 'core.errorBoundary.benchmark.reload',
                logScope: 'Benchmark',
            }}
        >
            <BenchmarkApp />
        </RendererRoot>
    </StrictMode>,
);
