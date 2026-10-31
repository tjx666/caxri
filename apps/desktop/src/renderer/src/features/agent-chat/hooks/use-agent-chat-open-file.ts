import { useCallback } from 'react';

import { parseFileLocation } from '@caxri/protocol';

import { openTerminalFileTarget } from '../../terminal/terminal-file-link-open';
import { terminalPaneHost } from '../../terminal/terminal-pane-host';

/**
 * Opens a file an Agent cites in `terminalId`'s Chat or one of its subagent tabs, resolved exactly like a path printed
 * in a Terminal: against the Projects that Terminal may reach, with the same candidate picker when several match.
 */
export function useAgentChatOpenFile(terminalId: string): (reference: string) => void {
    return useCallback(
        (reference: string) => {
            const { target, location } = parseFileLocation(reference);
            void openTerminalFileTarget(terminalId, target, location, {
                hasWorkbenchLinks: terminalPaneHost().hasWorkbenchLinks,
            });
        },
        [terminalId],
    );
}
