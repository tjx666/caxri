// Keep first: arms opt-in react-scan render counting before react-dom evaluates (see electron.vite.config.ts).
import 'virtual:caxri-react-scan-boot';
import '@xterm/xterm/css/xterm.css';
import './styles/terminal-fonts.css';
import './styles/styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app';
import { toastActionHandlers } from './commands/toast-actions';
import { installRendererPerformanceMonitoring } from './features/renderer-performance/controller';
import { installStoreInspector } from './lib/store';
import { observeWindowActive } from './lib/window-active';
import { installRendererErrorReporter } from './renderer-error-reporter';
import { RendererRoot } from './renderer-root';
import { configureToastActions } from './stores/toast-actions';
import { syncWorkbenchLocale } from './stores/workbench-locale';

installRendererErrorReporter((kind) => globalThis.caxri.reportError(kind));
installRendererPerformanceMonitoring();
installStoreInspector();
observeWindowActive();
syncWorkbenchLocale();
// Before the first render, because a notification raised during boot has to know what its button does the moment it is
// shown; the store that records notifications may not reach the feature modules that answer for them.
configureToastActions(toastActionHandlers);

createRoot(document.querySelector('#root')!).render(
    <StrictMode>
        <RendererRoot>
            <App />
        </RendererRoot>
    </StrictMode>,
);
