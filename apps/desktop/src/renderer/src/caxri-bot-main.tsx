// Keep first: arms opt-in react-scan render counting before react-dom evaluates (see electron.vite.config.ts).
import 'virtual:caxri-react-scan-boot';
import '@xterm/xterm/css/xterm.css';
import './styles/terminal-fonts.css';
import './styles/styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { installDwellShimmerRest } from './features/agent-chat/activity/dwell-shimmer-rest';
import { configureAgentChatAttachmentsForBot } from './features/agent-chat/composer-input/agent-chat-drafts';
import { readCaxriBotWorkbench } from './features/caxri-bot/bot-client';
import { configureBotTerminalHost } from './features/caxri-bot/bot-commands';
import { configureBotToastActions } from './features/caxri-bot/bot-toast-actions';
import { CaxriBotApp } from './features/caxri-bot/caxri-bot-app';
import { observePowerSource } from './lib/power-source';
import { installStoreInspector } from './lib/store';
import { observeWindowActive } from './lib/window-active';
import { installRendererErrorReporter } from './renderer-error-reporter';
import { RendererRoot } from './renderer-root';
import { configureWorkbenchSnapshotSource } from './stores/workbench';
import { syncWorkbenchLocale } from './stores/workbench-locale';

installRendererErrorReporter((kind) => globalThis.caxri.reportError(kind));
installStoreInspector();
observeWindowActive();
observePowerSource();
installDwellShimmerRest();
syncWorkbenchLocale();
// Before the first render: Main denies this window `app.bootstrap`, so every shared refresh path must already read the
// Caxri Bot-scoped snapshot by the time a Terminal pane can trigger one.
configureWorkbenchSnapshotSource(readCaxriBotWorkbench);
configureBotToastActions();
configureBotTerminalHost();
configureAgentChatAttachmentsForBot();

createRoot(document.querySelector('#root')!).render(
    <StrictMode>
        <RendererRoot
            boundary={{
                titleKey: 'core.errorBoundary.caxriBot.title',
                descriptionKey: 'core.errorBoundary.caxriBot.description',
                reloadLabelKey: 'core.errorBoundary.caxriBot.reload',
                logScope: 'Caxri Bot',
            }}
        >
            <CaxriBotApp />
        </RendererRoot>
    </StrictMode>,
);
