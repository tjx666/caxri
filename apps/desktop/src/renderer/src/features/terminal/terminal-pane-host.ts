import { openSettings } from '../../stores/dialogs';

/**
 * What a Terminal pane asks of the window hosting it. The Workbench hosts every surface a pane action opens; a
 * companion window such as the Agent Commander has none of them, so it installs its own host before its first render.
 */
export interface TerminalPaneHost {
    /**
     * Opens Settings, where the user points Caxri at a missing Agent CLI.
     */
    openSettings(): void;
    /**
     * Whether links may resolve through the Workbench: file links open its editor, commit links its Git view, and a
     * reference's hover card loads its details from the Session's Git. Without it only URLs are links, and a reference
     * keeps its basic card.
     */
    hasWorkbenchLinks: boolean;
}

const installed: { host: TerminalPaneHost } = {
    host: { openSettings: () => openSettings(), hasWorkbenchLinks: true },
};

export function configureTerminalPaneHost(host: TerminalPaneHost): void {
    installed.host = host;
}

export function terminalPaneHost(): TerminalPaneHost {
    return installed.host;
}
