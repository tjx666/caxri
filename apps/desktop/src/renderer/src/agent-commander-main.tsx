import '@xterm/xterm/css/xterm.css';
import './styles/terminal-fonts.css';
import './styles/styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { QueryClientProvider } from '@tanstack/react-query';

import { ErrorBoundary } from './components/error-boundary';
import { AgentCommanderApp } from './features/agent-commander/agent-commander-app';
import { readAgentCommanderWorkbench } from './features/agent-commander/commander-client';
import { configureCommanderToastActions } from './features/agent-commander/commander-toast-actions';
import { installStoreInspector } from './lib/store';
import { observeWindowActive } from './lib/window-active';
import { queryClient } from './queries/client';
import { installRendererErrorReporter } from './renderer-error-reporter';
import { configureWorkbenchSnapshotSource } from './stores/workbench';

installRendererErrorReporter((kind) => globalThis.caxri.reportError(kind));
installStoreInspector();
observeWindowActive();
// Before the first render: Main denies this window `app.bootstrap`, so every shared refresh path must already read the
// Commander-scoped snapshot by the time a Terminal pane can trigger one.
configureWorkbenchSnapshotSource(readAgentCommanderWorkbench);
configureCommanderToastActions();

createRoot(document.querySelector('#root')!).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <ErrorBoundary
                title="Agent Commander stopped rendering"
                description="Reload Agent Commander to reconnect to its Terminal. The Commander keeps running meanwhile."
                reloadLabel="Reload Agent Commander"
                logScope="Agent Commander"
            >
                <AgentCommanderApp />
            </ErrorBoundary>
        </QueryClientProvider>
    </StrictMode>,
);
