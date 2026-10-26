import { findResourceTabs } from '@caxri/protocol';

import { translate } from '../../../i18n';
import { getBootstrap, getSessionState } from '../../../stores/selectors';
import { tryCommand } from '../../../stores/toasts';
import { createTerminalForSession } from '../../terminal/terminal-commands';
import { sendTerminalInputAtPrompt } from '../../terminal/terminal-prompt-input';

/**
 * Fence words whose body is a command line for the user's shell. `console` and `fish` stay out: a `console` transcript
 * mixes `$` prompts with output, and fish syntax does not run in the zsh or bash most users have.
 */
const SHELL_FENCES = new Set(['bash', 'sh', 'shell', 'shellscript', 'zsh']);

export function isRunnableShellFence(language: string | undefined): boolean {
    return SHELL_FENCES.has(language?.trim().toLowerCase() ?? '');
}

/**
 * The keystrokes that run `code` at a shell prompt: each line ends with the Return key xterm sends (`\r`), so a
 * multi-line block runs line by line, as if the user had typed it. Trailing blank lines are dropped so the block does
 * not end with empty Returns.
 */
export function shellInputForCode(code: string): string {
    const lines = code.replaceAll(/\r\n?/gu, '\n').trimEnd().split('\n');
    return lines.map((line) => `${line}\r`).join('');
}

/**
 * The last Terminal a Chat ran a block in, so the next Run opens beside it instead of splitting the Chat again.
 * Renderer-lifetime only: after a reload the first Run splits a new pane, which is harmless.
 */
const runTerminalByChat = new Map<string, string>();

/**
 * Runs a Chat reply's shell block, as the Claude Code desktop app's Run button beside Copy does, in a new shell
 * Terminal of the Chat's Session, started in the folder the Agent works in (`agentCwd` after Claude Code entered a
 * worktree), so a relative command such as `bun run db:migrate` targets the same checkout the Agent described. The
 * first Run splits a pane below the Chat so the reply stays readable; later Runs open as tabs in that pane while it is
 * still open. The command is typed at the shell's first prompt (`sendTerminalInputAtPrompt`) rather than passed to
 * `terminal.create`, so it stays in shell history and can be interrupted like any typed command.
 */
export async function runAgentChatCode(chatTerminalId: string, code: string): Promise<void> {
    const chat = getBootstrap()?.terminals.find((terminal) => terminal.id === chatTerminalId);
    if (!chat) return;
    const layout = getSessionState()?.paneLayout;
    const previousRunId = runTerminalByChat.get(chatTerminalId);
    const previousRunPane =
        layout && previousRunId
            ? findResourceTabs(layout, { kind: 'terminal', terminalId: previousRunId }).at(0)?.pane
            : undefined;
    const chatPane = layout
        ? findResourceTabs(layout, { kind: 'terminal', terminalId: chatTerminalId }).at(0)?.pane
        : undefined;
    const terminalId = await createTerminalForSession(chat.sessionId, 'shell', {
        cwd: chat.agentCwd ?? chat.cwd,
        ...(previousRunPane
            ? { paneId: previousRunPane.id }
            : chatPane && { paneId: chatPane.id, split: 'down' as const }),
    });
    if (!terminalId) return;
    runTerminalByChat.set(chatTerminalId, terminalId);
    await tryCommand(translate('terminal.errors.inputFailed'), () =>
        sendTerminalInputAtPrompt(terminalId, shellInputForCode(code)),
    );
}
