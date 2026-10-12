import { useCallback } from 'react';

import { openTerminalFileTarget } from '../../terminal/terminal-file-link-open';
import { parseTerminalFileLocation } from '../../terminal/terminal-file-location';
import { terminalPaneHost } from '../../terminal/terminal-pane-host';

/**
 * Opens a file an Agent cites in `terminalId`'s Chat or one of its subagent tabs, resolved exactly like a path printed
 * in a Terminal: against the Projects that Terminal may reach, with the same candidate picker when several match.
 */
export function useAgentChatOpenFile(terminalId: string): (reference: string) => void {
    return useCallback(
        (reference: string) => {
            const { target, location } = parseTerminalFileLocation(reference);
            // eslint-disable-next-line no-void -- the opener reports its own failures as toasts
            void openTerminalFileTarget(terminalId, target, location, {
                hasWorkbenchLinks: terminalPaneHost().hasWorkbenchLinks,
            });
        },
        [terminalId],
    );
}
