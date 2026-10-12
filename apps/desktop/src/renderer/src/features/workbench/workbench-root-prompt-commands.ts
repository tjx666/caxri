import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { describeFailure, pushToast } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import type { WorkbenchRootCandidate } from './workbench-root-prompt-store';
import { dismissWorkbenchRootCandidate } from './workbench-root-prompt-store';

/**
 * Adopts the discovered worktree as the Session's Workbench Root. The prompt is cleared on both outcomes: a failed
 * switch leaves the Session where it was, and a candidate the Server already rejected must not strand the prompt.
 */
export async function continueSessionInWorktree(
    sessionId: string,
    candidate: WorkbenchRootCandidate,
): Promise<void> {
    try {
        await caxri.request('session.continueInWorktree', {
            candidateId: candidate.candidateId,
            sessionId: candidate.sessionId,
        });
        dismissWorkbenchRootCandidate(sessionId);
        await refreshWorkbench();
    } catch (error) {
        dismissWorkbenchRootCandidate(sessionId);
        pushToast(
            'error',
            describeFailure(error, translate('workbench.rootPrompt.continueFailed')),
        );
    }
}

/**
 * Declines the suggestion so the Server stops offering this candidate. An expired candidate is already inert there and
 * must not strand the prompt, so the local dismissal happens either way.
 */
export async function dismissWorkbenchCandidate(
    sessionId: string,
    candidate: WorkbenchRootCandidate,
): Promise<void> {
    try {
        await caxri.request('session.dismissWorkbenchCandidate', {
            candidateId: candidate.candidateId,
            sessionId: candidate.sessionId,
        });
    } catch (error) {
        pushToast('error', describeFailure(error, translate('workbench.rootPrompt.dismissFailed')));
    } finally {
        dismissWorkbenchRootCandidate(sessionId);
    }
}
