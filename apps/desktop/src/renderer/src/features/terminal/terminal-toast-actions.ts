import { getBootstrap } from '../../stores/selectors';
import type { ToastActionHandlers } from '../../stores/toast-actions';
import {
    refreshTerminalState,
    restartTerminalWithRecovery,
    stopTerminal,
} from './terminal-commands';
import { dismissTerminalResourceAlert } from './terminal-resource-alerts';

/**
 * The follow-ups a Terminal pane's own failures offer. Every window that mounts a Terminal pane installs these, which
 * is why they live beside the pane rather than only in the Workbench's full handler table.
 */
export const terminalToastActionHandlers: Pick<
    ToastActionHandlers,
    'terminal.refresh' | 'terminal.restart' | 'terminal.stopRunaway'
> = {
    'terminal.refresh': { run: refreshTerminalState },
    'terminal.restart': {
        /**
         * Restart replaces a live PTY, so this asks two questions, not one. The Terminal must still be open, and it
         * must still be running the process the failure was about: a different one means somebody already restarted it,
         * and retrying then would kill work that is running right now.
         */
        unavailable: ({ processId, terminalId }) => {
            const terminal = getBootstrap()?.terminals.find((entry) => entry.id === terminalId);
            if (!terminal) return 'That Terminal is no longer open.';
            return terminal.processId === processId
                ? undefined
                : 'That Terminal has already been restarted.';
        },
        run: ({ terminalId }) => restartTerminalWithRecovery(terminalId),
    },
    'terminal.stopRunaway': {
        unavailable: ({ processId, terminalId }) => {
            const terminal = getBootstrap()?.terminals.find((entry) => entry.id === terminalId);
            if (!terminal) return 'That Terminal is no longer open.';
            return terminal.processId === processId
                ? undefined
                : 'That Terminal is no longer running the process that was using too many resources.';
        },
        run: ({ terminalId }) => {
            dismissTerminalResourceAlert(terminalId);
            stopTerminal(terminalId);
        },
    },
};
