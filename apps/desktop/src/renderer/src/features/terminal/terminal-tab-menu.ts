import type { TerminalRecord } from '@caxri/protocol';

import type { ContextMenuEntries } from '../../lib/context-menu';
import { moveTerminalToNewSession } from '../session/session-commands';
import { agentReloadMenuEntry } from './terminal-reload-commands';
import { agentResumeCommandMenuEntry, terminalSurfaceMenuEntry } from './terminal-surface-commands';

/**
 * The Terminal-specific entries appended to a Terminal tab's context menu (see `paneTabMenu`).
 */
export function terminalTabMenuEntries(
    terminal: TerminalRecord,
    isOnlySessionTerminal: boolean,
): ContextMenuEntries {
    const surfaceEntry = terminalSurfaceMenuEntry(terminal);
    return [
        // A Shell tab has no Agent to reload; the entry would only ever be disabled there.
        terminal.provider && agentReloadMenuEntry(terminal),
        {
            label: 'Move to New Session',
            disabled: isOnlySessionTerminal,
            disabledReason: 'This is the only tab open in this session',
            onSelect: () => moveTerminalToNewSession(terminal.id, isOnlySessionTerminal),
        },
        ...(surfaceEntry ? [surfaceEntry] : []),
        terminal.provider && agentResumeCommandMenuEntry(terminal),
    ];
}
