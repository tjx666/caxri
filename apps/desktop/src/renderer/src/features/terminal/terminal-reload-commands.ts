import type { AgentChatSnapshot, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { agentProviderCatalog, isChatTerminal } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import type { ContextMenuEntry } from '../../lib/context-menu';
import { getBootstrap } from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { readAgentChatSnapshot } from '../agent-chat/agent-chat-client';
import { restartTerminalWithRecovery } from './terminal-commands';

const RELOAD_AGENT_FAILED = 'Reload Agent failed';

type ReloadAgentTerminal = Pick<
    TerminalRecord,
    | 'agentSessionId'
    | 'id'
    | 'kind'
    | 'lastAgentProcessState'
    | 'lastProcessState'
    | 'provider'
    | 'sessionId'
    | 'surface'
>;

/**
 * Why Reload Agent is unavailable for this Terminal, or `undefined` when it can run. Reloading continues the Agent
 * Session, so an Agent that has not written a conversation yet has nothing to reload, and a detached Agent was handed
 * to another client on purpose: only Resume Agent takes it back. `missingConversationReason` lets a menu that already
 * explains a missing Agent or conversation for its other entries reuse that one sentence here.
 */
function reloadAgentBlockedReason(
    terminal: Pick<TerminalRecord, 'agentSessionId' | 'lastProcessState' | 'provider'> | undefined,
    missingConversationReason: string | undefined,
): string | undefined {
    if (!terminal?.provider)
        return missingConversationReason ?? 'This Session has no Agent Terminal';
    if (terminal.lastProcessState === 'detached') return 'Resume the detached Agent first';
    if (!terminal.agentSessionId)
        return (
            missingConversationReason ??
            'Send a message first; there is no conversation to reload yet'
        );
    return undefined;
}

/**
 * Whether the Agent in `terminal` is mid-turn, so reloading it would end that turn. Mirrors the Server's check behind
 * `terminal.switchSurface`'s `turnRunning` result (`terminal-surface-switch.ts`): Session Activity reports a running or
 * waiting turn for the Session's Primary Agent, and a PTY Agent must still have its process alive. `terminal.restart`
 * has no such result, so the Renderer asks before sending it.
 *
 * Session Activity tracks the Primary Agent only. A secondary Chat answers from its own snapshot instead, since the
 * Chat knows whether a turn is active (issue caxri#1630). A secondary PTY Agent has no per-Terminal activity, so it
 * reads as idle, the same answer the Server gives it for a PTY switch.
 */
export function isAgentTurnRunning(
    terminal: Pick<TerminalRecord, 'id' | 'lastAgentProcessState' | 'surface'>,
    session: Pick<SessionRecord, 'lastActivityState' | 'primaryAgentTerminalId'> | undefined,
    chat?: Pick<AgentChatSnapshot, 'activeTurnId'>,
): boolean {
    if (session?.primaryAgentTerminalId !== terminal.id)
        return isChatTerminal(terminal) && Boolean(chat?.activeTurnId);
    if (session.lastActivityState !== 'running' && session.lastActivityState !== 'waiting')
        return false;
    return isChatTerminal(terminal) || terminal.lastAgentProcessState === 'running';
}

/**
 * A secondary Chat's snapshot for {@link isAgentTurnRunning}; unread for every other Terminal. An unreadable Chat
 * reloads without asking, as before, rather than blocking the reload on a failed read.
 */
async function secondaryChatSnapshot(
    terminal: Pick<TerminalRecord, 'id' | 'surface'>,
    session: Pick<SessionRecord, 'primaryAgentTerminalId'> | undefined,
): Promise<AgentChatSnapshot | undefined> {
    if (!isChatTerminal(terminal) || session?.primaryAgentTerminalId === terminal.id)
        return undefined;
    try {
        return await readAgentChatSnapshot(terminal.id);
    } catch {
        return undefined;
    }
}

/**
 * Ends the current Agent Run and resumes the same Agent Session in the same Terminal. A running turn is never ended
 * silently, matching the Terminal and Chat switch: the user confirms first. The confirmation reads the latest bootstrap
 * rather than the menu's snapshot, because the turn may have finished while the menu was open.
 */
export async function reloadAgent(terminal: ReloadAgentTerminal): Promise<void> {
    const { provider } = terminal;
    if (!provider) return;
    const latest = getBootstrap();
    const current = latest?.terminals.find((entry) => entry.id === terminal.id) ?? terminal;
    const session = latest?.sessions.find((entry) => entry.id === terminal.sessionId);
    const chat = await secondaryChatSnapshot(current, session);
    if (isAgentTurnRunning(current, session, chat)) {
        const providerName = agentProviderCatalog[provider].displayName;
        const isConfirmed = await tryCommand(RELOAD_AGENT_FAILED, () =>
            caxri.window.showConfirm({
                title: 'Stop the running turn?',
                message: `${providerName} is still working. Reloading stops the current turn and resumes the same conversation.`,
                confirmLabel: 'Stop and Reload',
            }),
        );
        if (isConfirmed !== true) return;
    }
    restartTerminalWithRecovery(terminal.id, RELOAD_AGENT_FAILED);
}

/**
 * "Reload Agent" for the Session row menu (its Primary Agent) and an Agent Terminal tab menu: ends the current Agent
 * Run and resumes the same Agent Session in the same Terminal. It is the Terminal's own resume restart, including its
 * recovery offer, so the Server keeps the approval mode (YOLO) the replaced run launched with. No key hint:
 * `Command+Shift+R` restarts the active Terminal, while this entry acts on the clicked row or tab.
 */
export function agentReloadMenuEntry(
    terminal: ReloadAgentTerminal | undefined,
    missingConversationReason?: string,
): ContextMenuEntry {
    const blockedReason = reloadAgentBlockedReason(terminal, missingConversationReason);
    return {
        label: 'Reload Agent',
        disabled: blockedReason !== undefined,
        disabledReason: blockedReason,
        // eslint-disable-next-line no-void -- intentional floating-promise discard, the restart reports its own errors
        onSelect: () => terminal && void reloadAgent(terminal),
    };
}
