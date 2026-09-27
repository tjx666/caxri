import { caxri } from '../../lib/caxri';
import { openExternalUrl } from '../../lib/external-link';
import { pushToast, tryCommand } from '../../stores/toasts';

/**
 * Hands a board row to the Workbench window: Main selects the Session there and raises that window. The Commander
 * window never selects a Session itself; it has no Workbench selection to change.
 */
export function revealCommanderSession(sessionId: string): void {
    // Fire-and-forget: tryCommand reports a failed hand-off through a toast.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Unable to show this Session in the Workbench', () =>
        caxri.request('agentCommander.revealSession', { sessionId }),
    );
}

export function openCommanderPullRequest(url: string): void {
    // Fire-and-forget: openExternalUrl reports its own rejection through the callback.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void openExternalUrl(url, (message) => pushToast('error', message));
}
