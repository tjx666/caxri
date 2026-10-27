import type { AgentChatSnapshot, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { agentProviderCatalog, isChatTerminal } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { getBootstrap } from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { readAgentChatSnapshot } from '../agent-chat/agent-chat-client';

/**
 * Whether the Agent in `terminal` is mid-turn, so restarting it would end that turn. Mirrors the Server's check behind
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
    session: Pick<SessionRecord, 'agentActivityState' | 'primaryAgentTerminalId'> | undefined,
    chat?: Pick<AgentChatSnapshot, 'activeTurnId'>,
): boolean {
    if (session?.primaryAgentTerminalId !== terminal.id)
        return isChatTerminal(terminal) && Boolean(chat?.activeTurnId);
    if (session.agentActivityState !== 'running' && session.agentActivityState !== 'waiting')
        return false;
    return isChatTerminal(terminal) || terminal.lastAgentProcessState === 'running';
}

/**
 * Whether `terminal` is a Chat other than the Session's Primary Agent, the only Terminal whose turn state needs its own
 * snapshot. Every other Terminal skips the read, so its check stays synchronous.
 */
function isSecondaryChat(
    terminal: Pick<TerminalRecord, 'id' | 'surface'>,
    session: Pick<SessionRecord, 'primaryAgentTerminalId'> | undefined,
): boolean {
    return isChatTerminal(terminal) && session?.primaryAgentTerminalId !== terminal.id;
}

/**
 * A secondary Chat's snapshot for {@link isAgentTurnRunning}. An unreadable Chat proceeds without asking rather than
 * blocking the action on a failed read.
 */
async function readSecondaryChatSnapshot(
    terminal: Pick<TerminalRecord, 'id'>,
): Promise<AgentChatSnapshot | undefined> {
    try {
        return await readAgentChatSnapshot(terminal.id);
    } catch {
        return undefined;
    }
}

/**
 * The words a running-turn confirmation uses for one action: `outcome` finishes "`<Agent>` is still working.
 * `<outcome>`", and `failureTitle` names the action if the dialog itself fails.
 */
export interface EndTurnConfirmationCopy {
    confirmLabel: string;
    failureTitle: string;
    outcome: string;
    /**
     * The question to ask when no turn is running, for an action that must never happen silently even then (Start New
     * Conversation drops the binding the Terminal resumes from). Omitted, an idle Agent proceeds without a dialog.
     */
    idle?: { confirmLabel: string; message: string; title: string };
}

/**
 * Runs `proceed` for an action that ends the Terminal's current Agent Run, first asking the user when that would stop a
 * running turn. Every such action (Restart Agent from a menu, `terminal.restart`, the recovery row, Start New
 * Conversation, Detach Agent, Caxri Bot's Stop) comes through here, so none of them ends a turn silently while another
 * asks first. The check reads the latest bootstrap rather than a menu's snapshot, because the turn may have finished
 * while the menu was open.
 *
 * `proceed` runs synchronously when no turn is running and `copy.idle` is absent, so a caller that does not await still
 * sends its request in the same tick. The exceptions are a secondary Chat, whose turn state is read from its snapshot
 * first, and `copy.idle`, which asks its own question instead; a running turn asks only the running-turn question, so
 * the user never answers two dialogs for one action.
 */
export async function confirmBeforeEndingTurn(
    terminalId: string,
    copy: EndTurnConfirmationCopy,
    proceed: () => void,
): Promise<void> {
    const latest = getBootstrap();
    const terminal = latest?.terminals.find((entry) => entry.id === terminalId);
    const session = terminal?.provider
        ? latest?.sessions.find((entry) => entry.id === terminal.sessionId)
        : undefined;
    const chat =
        terminal?.provider && isSecondaryChat(terminal, session)
            ? await readSecondaryChatSnapshot(terminal)
            : undefined;
    if (!terminal?.provider || !isAgentTurnRunning(terminal, session, chat)) {
        const { idle } = copy;
        if (!idle) {
            proceed();
            return;
        }
        const isIdleConfirmed = await tryCommand(copy.failureTitle, () =>
            caxri.window.showConfirm(idle),
        );
        if (isIdleConfirmed === true) proceed();
        return;
    }
    const providerName = agentProviderCatalog[terminal.provider].displayName;
    const isConfirmed = await tryCommand(copy.failureTitle, () =>
        caxri.window.showConfirm({
            title: translate('terminal.turnGuard.title'),
            message: translate('terminal.turnGuard.message', {
                outcome: copy.outcome,
                provider: providerName,
            }),
            confirmLabel: copy.confirmLabel,
        }),
    );
    if (isConfirmed === true) proceed();
}
