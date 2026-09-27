import { isLongPasteWithinLimit } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { isAgentProcessRunning } from '../../lib/terminal-agent-runtime';
import { getBootstrap, getSessionState } from '../../stores/selectors';
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

export type GitReviewSendResult = { ok: true } | { ok: false; message: string };

/**
 * Keep review drafts until the complete Terminal write succeeds. This always runs while the send Dialog is open, so a
 * failure is returned rather than pushed as a toast: DESIGN.md's Dialogs/Toasts rule says a failure the dialog can
 * report in place belongs in the dialog, not in a toast behind it. The caller renders the message inline and keeps the
 * dialog open with Send re-enabled.
 */
export async function sendGitReviewComments(
    sessionId: string,
    comments: readonly GitReviewComment[],
    prompt: string,
): Promise<GitReviewSendResult> {
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
    if (!agent) return { ok: false, message: 'No running Agent Terminal in this Session' };
    if (!isLongPasteWithinLimit(prompt))
        return {
            ok: false,
            message: 'These review comments are too long to send at once. Send fewer comments.',
        };
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
        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            message: error instanceof Error ? error.message : 'Unable to send review comments',
        };
    }
}
