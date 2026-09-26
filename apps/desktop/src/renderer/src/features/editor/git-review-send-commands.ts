import { isLongPasteWithinLimit } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { isAgentProcessRunning } from '../../lib/terminal-agent-runtime';
import { getBootstrap, getSessionState } from '../../stores/selectors';
import { pushToast } from '../../stores/toasts';
import {
    activateTerminal,
    focusTerminalById,
    sendTerminalInput,
    sendTerminalInputToAgent,
    whenTerminalAttached,
} from '../terminal/terminal-commands';
import { formatLongPasteReference } from '../terminal/terminal-long-paste';
import { chooseReferenceTerminal } from './file-reference';
import type { GitReviewComment } from './git-review-comments';
import { formatReviewTerminalInput, useGitReviewComments } from './git-review-comments';

/**
 * Keep review drafts until the complete Terminal write succeeds.
 */
export async function didSendGitReviewComments(
    sessionId: string,
    comments: readonly GitReviewComment[],
    prompt: string,
): Promise<boolean> {
    const bootstrap = getBootstrap();
    const agent =
        bootstrap &&
        chooseReferenceTerminal(
            bootstrap.terminals.filter(
                (terminal) =>
                    terminal.provider && isAgentProcessRunning(terminal.lastAgentProcessState),
            ),
            sessionId,
            getSessionState()?.paneLayout,
        );
    if (!agent) {
        pushToast('error', 'No running Agent Terminal in this Session');
        return false;
    }
    if (!isLongPasteWithinLimit(prompt)) {
        pushToast('error', 'Review comments exceed the 16 MiB input limit');
        return false;
    }
    try {
        activateTerminal(agent.id);
        if (!(await whenTerminalAttached(agent.id, 3000)))
            throw new Error('Agent Terminal is not ready for input');
        if (prompt.length > 4000) {
            const result = await caxri.request('terminal.prepareLongPaste', {
                terminalId: agent.id,
                content: prompt,
            });
            if (result.status === 'saved')
                await sendTerminalInputToAgent(
                    agent.id,
                    formatReviewTerminalInput(
                        `${formatLongPasteReference(result)}\nAddress every review comment in that file.`,
                    ),
                    result.agentLaunchId,
                );
            else throw new Error('Review comments require a managed Agent Terminal');
        } else await sendTerminalInput(agent.id, formatReviewTerminalInput(prompt), true);
        useGitReviewComments.getState().markSent(comments.map((comment) => comment.id));
        focusTerminalById(agent.id);
        return true;
    } catch (error) {
        pushToast(
            'error',
            error instanceof Error ? error.message : 'Unable to send review comments',
        );
        return false;
    }
}
