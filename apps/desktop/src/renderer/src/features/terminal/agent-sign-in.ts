import { translate } from '../../i18n';
import { pushToast, tryCommand } from '../../stores/toasts';
import { createTerminalForSession } from './terminal-commands';
import { sendTerminalInputAtPrompt } from './terminal-prompt-input';

/**
 * Types an Agent's sign-in command (`agentSignInCommand`) at a new Shell Terminal's first prompt without pressing
 * Return: signing in opens a browser or asks for a key, so the user starts it when ready and can still edit it, for
 * example to point at a CLI installed under another name.
 */
export async function typeAgentSignInCommand(terminalId: string, command: string): Promise<void> {
    await tryCommand(translate('terminal.errors.inputFailed'), async () => {
        await sendTerminalInputAtPrompt(terminalId, command);
        // The command is only typed, so say who has to press Return; otherwise the Terminal looks like it did nothing.
        pushToast('info', translate('terminal.new.signInTyped'), { history: false });
    });
}

/**
 * The New Terminal menu's "Sign in…": a Shell Terminal in the menu's Session with the sign-in command typed in.
 */
export async function openAgentSignInTerminal(
    sessionId: string,
    command: string,
    options: { paneId?: string } = {},
): Promise<void> {
    const terminalId = await createTerminalForSession(sessionId, 'shell', options);
    if (terminalId) await typeAgentSignInCommand(terminalId, command);
}
