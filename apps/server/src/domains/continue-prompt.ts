import type { TerminalSurface } from '@caxri/protocol';

import type { AgentChatService } from './agent-chat';
import { isPtyTerminal } from './pty-guard';
import type { TerminalManager } from './terminal';

/**
 * Where a continue prompt goes: a Chat turn, or an exact submission to a PTY Agent's current launch.
 */
export interface ContinuePromptTargets {
    agentChat: Pick<AgentChatService, 'send'>;
    terminals: Pick<TerminalManager, 'agentLaunchId' | 'submitAgentExact'>;
}

/**
 * Sends a continue prompt Caxri writes itself after pausing an Agent (Airplane Mode, "Quit and Stop Tasks"). It goes
 * with the `delegation` origin, so it is not recorded as user input: a delegated child that Caxri only paused keeps its
 * task and its parent keeps following it up, as with a pull request merge notice (issue #3865). The pause is not user
 * input either: Airplane Mode interrupts through `AgentChatService.interrupt`, not the user-facing handler.
 *
 * A PTY Agent's prompt is submitted only to its current launch; with none, there is nothing to continue.
 */
export async function sendContinuePrompt(
    { agentChat, terminals }: ContinuePromptTargets,
    terminal: { id: string; surface?: TerminalSurface },
    sessionId: string,
    text: string,
): Promise<void> {
    if (!isPtyTerminal(terminal)) {
        await agentChat.send(terminal.id, { text }, 'queue', 'delegation');
        return;
    }
    const launchId = terminals.agentLaunchId(terminal.id);
    if (launchId)
        await terminals.submitAgentExact(
            terminal.id,
            sessionId,
            launchId,
            text,
            undefined,
            'delegation',
        );
}
