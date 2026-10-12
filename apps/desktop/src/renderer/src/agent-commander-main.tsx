// Keep first: arms opt-in react-scan render counting before react-dom evaluates (see electron.vite.config.ts).
import 'virtual:caxri-react-scan-boot';
import '@xterm/xterm/css/xterm.css';
import './styles/terminal-fonts.css';
import './styles/styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { QueryClientProvider } from '@tanstack/react-query';

import { ErrorBoundary } from './components/error-boundary';
import { configureAgentChatAttachmentsForCommander } from './features/agent-chat/agent-chat-drafts';
import { AgentCommanderApp } from './features/agent-commander/agent-commander-app';
import { readAgentCommanderWorkbench } from './features/agent-commander/commander-client';
import { configureCommanderTerminalHost } from './features/agent-commander/commander-commands';
import { configureCommanderToastActions } from './features/agent-commander/commander-toast-actions';
import { I18nProvider } from './i18n';
import { installStoreInspector } from './lib/store';
import { observeWindowActive } from './lib/window-active';
import { queryClient } from './queries/client';
import { installRendererErrorReporter } from './renderer-error-reporter';
import { configureWorkbenchSnapshotSource } from './stores/workbench';
import { syncWorkbenchLocale } from './stores/workbench-locale';

installRendererErrorReporter((kind) => globalThis.caxri.reportError(kind));
installStoreInspector();
observeWindowActive();
syncWorkbenchLocale();
// Before the first render: Main denies this window `app.bootstrap`, so every shared refresh path must already read the
// Commander-scoped snapshot by the time a Terminal pane can trigger one.
configureWorkbenchSnapshotSource(readAgentCommanderWorkbench);
configureCommanderToastActions();
configureCommanderTerminalHost();
configureAgentChatAttachmentsForCommander();

createRoot(document.querySelector('#root')!).render(
    <StrictMode>
        <I18nProvider>
            <QueryClientProvider client={queryClient}>
                <ErrorBoundary
                    titleKey="core.errorBoundary.agentCommander.title"
                    descriptionKey="core.errorBoundary.agentCommander.description"
                    reloadLabelKey="core.errorBoundary.agentCommander.reload"
                    logScope="Agent Commander"
                >
                    <AgentCommanderApp />
                </ErrorBoundary>
            </QueryClientProvider>
        </I18nProvider>
    </StrictMode>,
);
