// Keep first: arms opt-in react-scan render counting before react-dom evaluates (see electron.vite.config.ts).
import 'virtual:caxri-react-scan-boot';
import '@xterm/xterm/css/xterm.css';
import './styles/terminal-fonts.css';
import './styles/styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { configureAgentChatAttachmentsForCommander } from './features/agent-chat/composer-input/agent-chat-drafts';
import { AgentCommanderApp } from './features/agent-commander/agent-commander-app';
import { readAgentCommanderWorkbench } from './features/agent-commander/commander-client';
import { configureCommanderTerminalHost } from './features/agent-commander/commander-commands';
import { configureCommanderToastActions } from './features/agent-commander/commander-toast-actions';
import { installStoreInspector } from './lib/store';
import { observeWindowActive } from './lib/window-active';
import { installRendererErrorReporter } from './renderer-error-reporter';
import { RendererRoot } from './renderer-root';
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
        <RendererRoot
            boundary={{
                titleKey: 'core.errorBoundary.agentCommander.title',
                descriptionKey: 'core.errorBoundary.agentCommander.description',
                reloadLabelKey: 'core.errorBoundary.agentCommander.reload',
                logScope: 'Agent Commander',
            }}
        >
            <AgentCommanderApp />
        </RendererRoot>
    </StrictMode>,
);
