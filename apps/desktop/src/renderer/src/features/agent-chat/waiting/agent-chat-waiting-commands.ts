import { getSelectedSession } from '../../../stores/selectors';
import { didSelectSession } from '../../session/session-commands';
import { activateTerminal } from '../../terminal/terminal-commands';

/**
 * Opens the Chat a waiting card asks for: its Session first, then its tab, because `activateTerminal` reveals a tab
 * only in the selected Session. Once the pane is on screen the popup lets that Chat go, and its own request card takes
 * over. A failed selection already toasted, so nothing else moves.
 */
export async function openAgentChatWaiting(sessionId: string, terminalId: string): Promise<void> {
    if (getSelectedSession()?.id !== sessionId && !(await didSelectSession(sessionId))) return;
    activateTerminal(terminalId);
}
