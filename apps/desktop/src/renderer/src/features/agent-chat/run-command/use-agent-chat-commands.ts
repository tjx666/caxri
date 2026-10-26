import { useMemo } from 'react';

import type { MarkdownCommandHost } from '../../../components/markdown/markdown-context';
import { isRunnableShellFence, runAgentChatCode } from './agent-chat-run-command';

/**
 * Lets a Chat reply's shell fences run in a Terminal of the Chat's Session (`runAgentChatCode`). Undefined without a
 * Chat Terminal, such as a task tab's read-only timeline, so those blocks only copy.
 */
export function useAgentChatCommands(
    terminalId: string | undefined,
): MarkdownCommandHost | undefined {
    return useMemo(
        () =>
            terminalId
                ? {
                      canRun: isRunnableShellFence,
                      run: (command) => {
                          // runAgentChatCode reports its own failures in toasts.
                          void runAgentChatCode(terminalId, command);
                      },
                  }
                : undefined,
        [terminalId],
    );
}
