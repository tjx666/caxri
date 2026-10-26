import type { ThemeTokens } from '@caxri/protocol';
import type { Terminal } from '@xterm/xterm';

import {
    createTerminalCommandStatusElement,
    formatTerminalCommandCompletionStatus,
    registerTerminalCommandNavigation,
    terminalCommandDecorationDefaultColor,
    terminalCommandDecorationFailedColor,
    terminalCommandDecorationSucceededColor,
    TerminalCommandTracker,
} from './terminal-command-tracker';
import { notifyTerminalPrompt } from './terminal-prompt-input';

/**
 * Wires a Terminal pane's {@link TerminalCommandTracker}: the gutter decorations in the theme's colors, the command
 * counts mirrored onto the pane's `data-terminal-command-*` attributes, a live status element announcing completions,
 * keyboard command navigation, and the prompt signal that releases input queued by `sendTerminalInputAtPrompt`. Returns
 * the disposer for all of it.
 */
export function attachTerminalPaneCommandTracker({
    colors,
    container,
    terminalId,
    xterm,
}: {
    colors: {
        dangerColor: string | undefined;
        successColor: string | undefined;
        terminalTheme: ThemeTokens['terminal'] | undefined;
    };
    container: HTMLElement;
    terminalId: string;
    xterm: Terminal;
}): () => void {
    const statusElement = createTerminalCommandStatusElement();
    container.append(statusElement);
    let previousCompletedCommandCount = 0;
    const tracker = new TerminalCommandTracker(
        xterm,
        // VS Code registers a `terminalCommandDecoration.*` color per theme (dark/light/HC) rather than one fixed
        // hex; deriving these from the workbench `--danger` / `--success` tokens is the token-driven equivalent
        // (see terminal-command-tracker.ts).
        {
            failed: terminalCommandDecorationFailedColor(colors.dangerColor),
            running: terminalCommandDecorationDefaultColor(colors.terminalTheme?.foreground),
            succeeded: terminalCommandDecorationSucceededColor(colors.successColor),
        },
        ({ commandCount, completedCount, lastExitStatus }) => {
            container.dataset.terminalCommandCount = String(commandCount);
            container.dataset.terminalCommandCompletedCount = String(completedCount);
            if (lastExitStatus === undefined)
                delete container.dataset.terminalCommandLastExitStatus;
            else container.dataset.terminalCommandLastExitStatus = String(lastExitStatus);
            if (lastExitStatus !== undefined && completedCount > previousCompletedCommandCount)
                statusElement.textContent = formatTerminalCommandCompletionStatus(lastExitStatus);
            previousCompletedCommandCount = completedCount;
        },
        (status) => (statusElement.textContent = status),
        () => notifyTerminalPrompt(terminalId),
    );
    const unregisterNavigation = registerTerminalCommandNavigation(terminalId, (direction) =>
        tracker.navigate(direction),
    );
    return () => {
        unregisterNavigation();
        tracker.dispose();
        statusElement.remove();
    };
}
