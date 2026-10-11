import type { TerminalRecord } from '@caxri/protocol';

import type { ContextMenuEntry } from '../../lib/context-menu';
import { readCommandShortcut } from '../../lib/keybindings';
import { restartTerminal } from './terminal-commands';

type RestartAgentTerminal = Pick<
    TerminalRecord,
    'agentSessionId' | 'id' | 'lastProcessState' | 'provider'
>;

/**
 * Why Restart Agent is unavailable for this Terminal, or `undefined` when it can run. Restarting continues the Agent
 * Session, so an Agent that has not written a conversation yet has nothing to resume, and a detached Agent was handed
 * to another client on purpose: only Resume Agent takes it back. `missingConversationReason` lets a menu that already
 * explains a missing Agent or conversation for its other entries reuse that one sentence here.
 */
function restartAgentBlockedReason(
    terminal: Pick<TerminalRecord, 'agentSessionId' | 'lastProcessState' | 'provider'> | undefined,
    missingConversationReason: string | undefined,
): string | undefined {
    if (!terminal?.provider)
        return missingConversationReason ?? 'This Session has no Agent Terminal';
    if (terminal.lastProcessState === 'detached') return 'Resume the detached Agent first';
    if (!terminal.agentSessionId)
        return (
            missingConversationReason ??
            'Send a message first; there is no conversation to resume yet'
        );
    return undefined;
}

/**
 * "Restart Agent" for the Session row menu (its Primary Agent) and an Agent Terminal tab menu: ends the current Agent
 * Run and resumes the same Agent Session in the same Terminal. It is `terminal.restart` itself (the same name, the same
 * running-turn confirmation, and the Terminal's recovery offer, so the Server keeps the approval mode the replaced run
 * launched with), which is why it shows that command's key hint, as the tab menu's surface switch shows its own; the
 * shortcut acts on the active Terminal, the entry on the clicked row or tab.
 */
export function agentRestartMenuEntry(
    terminal: RestartAgentTerminal | undefined,
    missingConversationReason?: string,
): ContextMenuEntry {
    const blockedReason = restartAgentBlockedReason(terminal, missingConversationReason);
    return {
        label: 'Restart Agent',
        shortcut: readCommandShortcut('terminal.restart'),
        disabled: blockedReason !== undefined,
        disabledReason: blockedReason,
        onSelect: () => terminal && restartTerminal(terminal.id),
    };
}
