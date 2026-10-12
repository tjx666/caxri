import { caxri } from '../../lib/caxri';
import { isAgentProcessRunning } from '../../lib/terminal-agent-runtime';
import { getBootstrap, getSessionState } from '../../stores/selectors';
import { activateTerminal } from '../terminal/terminal-commands';
import { focusTerminalById, whenTerminalAttached } from '../terminal/terminal-pane-handlers';
import { chooseReferenceTerminal } from './file-reference';

export type GitReviewSendResult = { ok: true } | { ok: false; message: string };

/**
 * Keep review drafts until the complete Terminal write succeeds. This always runs while the send Dialog is open, so a
 * failure is returned rather than pushed as a toast: DESIGN.md's Dialogs/Toasts rule says a failure the dialog can
 * report in place belongs in the dialog, not in a toast behind it. The caller renders the message inline and keeps the
 * dialog open with Send re-enabled.
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
        chooseReferenceTerminal(
            bootstrap.terminals.filter(
                (terminal) =>
                    terminal.provider && isAgentProcessRunning(terminal.lastAgentProcessState),
            ),
            sessionId,
            getSessionState()?.paneLayout,
        );
    if (!agent) return { ok: false, message: 'No running Agent Terminal in this Session' };
    try {
        activateTerminal(agent.id);
        if (!(await whenTerminalAttached(agent.id, 3000)))
            throw new Error('Agent Terminal is not ready for input');
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
            message: error instanceof Error ? error.message : 'Unable to send review comments',
        };
    }
}
