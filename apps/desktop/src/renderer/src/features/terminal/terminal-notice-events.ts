import type { ServerEvent } from '@caxri/protocol';

import { reportTerminalOutputRecovery } from './terminal-output-recovery-notice';
import { reportTerminalPtyAlert } from './terminal-pty-alerts';
import { reportTerminalResourceAlert } from './terminal-resource-alerts';

export type TerminalNoticeEvent = Extract<
    ServerEvent,
    { event: 'terminal.outputRecovery' | 'terminal.ptyAlert' | 'terminal.resourceAlert' }
>;

/**
 * Routes the Server's Terminal notices (output recovery, a runaway process tree, PTY slots running out) to their
 * toasts.
 */
export function reportTerminalNoticeEvent(event: TerminalNoticeEvent): void {
    switch (event.event) {
        case 'terminal.outputRecovery':
            reportTerminalOutputRecovery(event.payload);
            return;
        case 'terminal.ptyAlert':
            reportTerminalPtyAlert(event.payload);
            return;
        case 'terminal.resourceAlert':
            reportTerminalResourceAlert(event.payload);
    }
}
