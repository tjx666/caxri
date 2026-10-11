import type { TerminalRecord } from '@caxri/protocol';

import type { ContextMenuEntries } from '../../lib/context-menu';
import { CONTEXT_MENU_SEPARATOR } from '../../lib/context-menu';
import { moveTerminalToNewSession } from '../session/session-commands';
import { agentRestartMenuEntry } from './agent-restart-commands';
import {
    agentResumeCommandMenuEntry,
    isAgentConversationResumable,
    terminalSurfaceMenuEntry,
} from './terminal-surface-commands';

/**
 * The Terminal-specific entries appended to a Terminal tab's context menu (see `paneTabMenu`), in three groups: what
 * this Agent runs as (switch surface, Restart Agent), where the tab lives (Move to New Session), and taking the
 * conversation elsewhere (Copy Resume Command). `serializeContextMenu` drops a separator left without neighbors, so a
 * Shell tab shows only its middle group.
 */
export async function terminalTabMenuEntries(
    terminal: TerminalRecord,
    isOnlySessionTerminal: boolean,
): Promise<ContextMenuEntries> {
    const isResumable = await isAgentConversationResumable(terminal);
    return [
        terminalSurfaceMenuEntry(terminal),
        // A Shell tab has no Agent to restart; the entry would only ever be disabled there.
        terminal.provider && agentRestartMenuEntry(terminal),
        CONTEXT_MENU_SEPARATOR,
        {
            label: 'Move to New Session',
            disabled: isOnlySessionTerminal,
            disabledReason: 'This is the only tab open in this Session',
            onSelect: () => moveTerminalToNewSession(terminal.id, isOnlySessionTerminal),
        },
        CONTEXT_MENU_SEPARATOR,
        terminal.provider && agentResumeCommandMenuEntry(terminal, isResumable),
    ];
}
