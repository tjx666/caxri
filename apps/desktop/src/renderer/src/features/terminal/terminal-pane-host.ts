import type { AgentProvider } from '@caxri/protocol';

import { useDialogStore } from '../../stores/dialogs';

/**
 * What a Terminal pane asks of the window hosting it. The Workbench hosts every surface a pane action opens; a
 * companion window such as the Agent Commander has none of them, so it installs its own host before its first render.
 */
export interface TerminalPaneHost {
    /**
     * Opens Settings, where the user points Caxri at a missing Agent CLI. `provider` scrolls straight to that Agent's
     * Executable row instead of Settings' default view, when the pane knows which Agent is missing.
     */
    openSettings(provider?: AgentProvider): void;
    /**
     * Whether links may resolve through the Workbench: file links open its editor, commit links its Git view, and a
     * reference's hover card loads its details from the Session's Git. Without it only URLs and files are links (file
     * links hand off to the Workbench through a different, authorized request; see `commander-commands.ts`), and a
     * reference keeps its basic card.
     */
    hasWorkbenchLinks: boolean;
}

const installed: { host: TerminalPaneHost } = {
    host: {
        openSettings: (provider) =>
            useDialogStore.getState().openSettings(provider ? 'agent-executable' : 'ui', provider),
        hasWorkbenchLinks: true,
    },
};

export function configureTerminalPaneHost(host: TerminalPaneHost): void {
    installed.host = host;
}

export function terminalPaneHost(): TerminalPaneHost {
    return installed.host;
}
