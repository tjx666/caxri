import { isChatTerminal } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { getBootstrap, getSessionState } from '../../stores/selectors';
import { chooseAgentPromptTerminal } from '../terminal/agent-prompt-commands';
import { activateTerminal } from '../terminal/terminal-commands';
import { focusTerminalById, whenTerminalAttached } from '../terminal/terminal-pane-handlers';

export type GitReviewSendResult = { ok: true } | { ok: false; message: string };

/**
 * Keep review drafts until the complete Terminal write succeeds. This always runs while the send Dialog is open, so a
 * failure is returned rather than pushed as a toast: DESIGN.md's Dialogs/Toasts rule says a failure the dialog can
 * report in place belongs in the dialog, not in a toast behind it. The caller renders the message inline and keeps the
 * dialog open with Send re-enabled.
 *
 * The target is the same Agent a palette prompt goes to (`chooseAgentPromptTerminal`): a Chat, which Server Core starts
 * or resumes on send and which needs no attached pane, or a Terminal whose Agent is running.
 *
 * Terminal selection, activation, and the attach wait stay in the Renderer because they depend on `PaneLayout`, a
 * Renderer-only concept the Server has no view of. Everything after that (reading the pending comments, building the
 * prompt, and writing it to the Terminal) runs on the Server (`gitReview.send`), so the prompt text built from the
 * Server-owned comment store never has to round-trip back through IPC first.
 */
export async function sendGitReviewComments(
    sessionId: string,
    repoId: string,
): Promise<GitReviewSendResult> {
    const bootstrap = getBootstrap();
    const agent =
        bootstrap &&
        chooseAgentPromptTerminal(bootstrap.terminals, sessionId, getSessionState()?.paneLayout);
    if (!agent) return { ok: false, message: translate('editor.reviewSend.noAgentTerminal') };
    try {
        if (isChatTerminal(agent)) {
            await caxri.request('gitReview.send', {
                sessionId,
                repositoryId: repoId,
                terminalId: agent.id,
            });
            activateTerminal(agent.id);
            return { ok: true };
        }
        activateTerminal(agent.id);
        if (!(await whenTerminalAttached(agent.id, 3000)))
            throw new Error(translate('editor.reviewSend.agentNotReady'));
        await caxri.request('gitReview.send', {
            sessionId,
            repositoryId: repoId,
            terminalId: agent.id,
        });
        focusTerminalById(agent.id);
        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            message: error instanceof Error ? error.message : translate('editor.reviewSend.failed'),
        };
    }
}
