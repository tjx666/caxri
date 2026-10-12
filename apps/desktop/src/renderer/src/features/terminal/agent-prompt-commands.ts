import type { PaneLayout, TerminalRecord } from '@caxri/protocol';
import {
    agentProviderCatalog,
    formatReviewTerminalInput,
    isChatTerminal,
    MAX_AGENT_CHAT_MESSAGE_LENGTH,
    MAX_TERMINAL_INPUT_LENGTH,
} from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { isAgentProcessRunning } from '../../lib/terminal-agent-runtime';
import { getBootstrap, getSelectedSession, getSessionState } from '../../stores/selectors';
import { chooseReferenceTerminal } from '../editor/file-reference';
import { activateTerminal } from './terminal-commands';
import { focusTerminalById, whenTerminalAttached } from './terminal-pane-handlers';

/**
 * Upper bound for a just-revealed Agent Terminal pane to mount and attach before the prompt is abandoned.
 */
const TERMINAL_ATTACH_TIMEOUT_MS = 3000;

/**
 * Bounded by the smaller of the two surfaces' input limits, minus the bracketed-paste envelope a Terminal Agent adds.
 */
export const MAX_AGENT_PROMPT_LENGTH = Math.min(
    MAX_AGENT_CHAT_MESSAGE_LENGTH,
    MAX_TERMINAL_INPUT_LENGTH - 16,
);

/**
 * Normalizes a prompt that came from outside the Renderer (an extension's tree action): line endings become `\n` and
 * every other control character is dropped, so nothing in it can end a Terminal Agent's bracketed paste early or inject
 * keystrokes. Returns `undefined` for anything that is not a non-empty string.
 */
export function agentPromptText(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = [...value.replaceAll('\r\n', '\n').replaceAll('\r', '\n')]
        .filter((character) => {
            const code = character.codePointAt(0)!;
            return code === 9 || code === 10 || (code >= 32 && code !== 127);
        })
        .join('')
        .trim();
    return text || undefined;
}

/**
 * The Session's Agent a prompt goes to: a Chat Terminal (Server Core starts or resumes its provider on send) or a
 * Terminal whose Agent is running. Among them the same rule as an editor reference: a visible one first, then the most
 * recently opened.
 */
export function chooseAgentPromptTerminal(
    terminals: readonly TerminalRecord[],
    sessionId: string,
    layout: PaneLayout | undefined,
): TerminalRecord | undefined {
    return chooseReferenceTerminal(
        terminals.filter(
            (terminal) =>
                terminal.provider !== undefined &&
                (isChatTerminal(terminal) || isAgentProcessRunning(terminal.lastAgentProcessState)),
        ),
        sessionId,
        layout,
    );
}

/**
 * Sends `prompt` to the selected Session's Agent and reveals it, resolving with the Agent's display name. A Chat gets
 * it as a message (queued behind a running turn); a Terminal Agent gets one bracketed paste followed by Enter, written
 * only after its pane attached because Server Core drops input for a Terminal without one. Throws with a user-facing
 * reason when there is no Agent or the write fails.
 */
export async function sendPromptToSessionAgent(prompt: string): Promise<string> {
    if (prompt.length > MAX_AGENT_PROMPT_LENGTH)
        throw new Error(translate('terminal.agentPrompt.tooLong'));
    const session = getSelectedSession();
    const bootstrap = getBootstrap();
    const terminal =
        session &&
        bootstrap &&
        chooseAgentPromptTerminal(bootstrap.terminals, session.id, getSessionState()?.paneLayout);
    if (!terminal?.provider) throw new Error(translate('terminal.agentPrompt.noAgent'));
    const agentName = agentProviderCatalog[terminal.provider].displayName;
    if (isChatTerminal(terminal)) {
        await caxri.request('agentChat.send', { terminalId: terminal.id, text: prompt });
        activateTerminal(terminal.id);
        return agentName;
    }
    activateTerminal(terminal.id);
    if (!(await whenTerminalAttached(terminal.id, TERMINAL_ATTACH_TIMEOUT_MS)))
        throw new Error(translate('terminal.agentPrompt.notReady', { agent: agentName }));
    await caxri.request('terminal.input', {
        terminalId: terminal.id,
        data: formatReviewTerminalInput(prompt),
        requireRunningAgent: true,
    });
    focusTerminalById(terminal.id);
    return agentName;
}
