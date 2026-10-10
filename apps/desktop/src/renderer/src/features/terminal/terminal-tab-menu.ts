import type { TerminalRecord } from '@caxri/protocol';

import type { ContextMenuEntries } from '../../lib/context-menu';
import { CONTEXT_MENU_SEPARATOR } from '../../lib/context-menu';
import { moveTerminalToNewSession } from '../session/session-commands';
import { agentReloadMenuEntry } from './terminal-reload-commands';
import { agentResumeCommandMenuEntry, terminalSurfaceMenuEntry } from './terminal-surface-commands';

/**
 * The Terminal-specific entries appended to a Terminal tab's context menu (see `paneTabMenu`), in three groups: what
 * this Agent runs as (switch surface, Reload Agent), where the tab lives (Move to New Session), and taking the
 * conversation elsewhere (Copy Resume Command). `serializeContextMenu` drops a separator left without neighbors, so a
 * Shell tab shows only its middle group.
 */
export function terminalTabMenuEntries(
    terminal: TerminalRecord,
    isOnlySessionTerminal: boolean,
): ContextMenuEntries {
    return [
        terminalSurfaceMenuEntry(terminal),
        // A Shell tab has no Agent to reload; the entry would only ever be disabled there.
        terminal.provider && agentReloadMenuEntry(terminal),
        CONTEXT_MENU_SEPARATOR,
        {
            label: 'Move to New Session',
            disabled: isOnlySessionTerminal,
            disabledReason: 'This is the only tab open in this session',
            onSelect: () => moveTerminalToNewSession(terminal.id, isOnlySessionTerminal),
        },
        CONTEXT_MENU_SEPARATOR,
        terminal.provider && agentResumeCommandMenuEntry(terminal),
    ];
}
