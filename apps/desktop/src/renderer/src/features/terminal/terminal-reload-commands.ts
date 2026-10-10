import type { TerminalRecord } from '@caxri/protocol';

import type { ContextMenuEntry } from '../../lib/context-menu';
import { restartTerminal } from './terminal-commands';

/**
 * Why Reload Agent is unavailable for this Terminal, or `undefined` when it can run. Reloading continues the bound
 * Agent Session, so an Agent that has not written a conversation yet has nothing to reload, and a detached Agent was
 * handed to another client on purpose: only Resume Agent takes it back.
 */
function reloadAgentBlockedReason(
    terminal: Pick<TerminalRecord, 'agentSessionId' | 'lastProcessState' | 'provider'> | undefined,
): string | undefined {
    if (!terminal?.provider) return 'This Session has no Agent Terminal';
    if (terminal.lastProcessState === 'detached') return 'Resume the detached Agent first';
    if (!terminal.agentSessionId)
        return 'Send a message first; there is no conversation to reload yet';
    return undefined;
}

/**
 * "Reload Agent" for the Session row menu (its Primary Agent) and an Agent Terminal tab menu: ends the current Agent
 * Run and resumes the same Agent Session in the same Terminal. It is the Terminal's own resume restart, including its
 * recovery offer, so the Server keeps the approval mode (YOLO) the replaced run launched with. No key hint:
 * `Command+Shift+R` restarts the active Terminal, while this entry acts on the clicked row or tab.
 */
export function agentReloadMenuEntry(
    terminal:
        Pick<TerminalRecord, 'agentSessionId' | 'id' | 'lastProcessState' | 'provider'> | undefined,
): ContextMenuEntry {
    const blockedReason = reloadAgentBlockedReason(terminal);
    return {
        label: 'Reload Agent',
        disabled: blockedReason !== undefined,
        disabledReason: blockedReason,
        onSelect: () => terminal && restartTerminal(terminal.id),
    };
}
