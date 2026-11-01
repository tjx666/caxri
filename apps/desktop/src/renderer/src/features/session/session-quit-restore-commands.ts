import type { SessionRestoreQuitStoppedResult } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { dismissToastsMatching, pushToast, tryCommand } from '../../stores/toasts';

const restore = { running: false };

function describeQuitRestore(result: SessionRestoreQuitStoppedResult): string {
    if (result.restored === 0 && result.skipped === 0) return translate('session.quitRestore.none');
    const headline = translate(
        result.restored === 1
            ? 'session.quitRestore.restoredOne'
            : 'session.quitRestore.restoredOther',
        { count: result.restored },
    );
    return result.skipped === 0
        ? headline
        : translate('session.quitRestore.skipped', { headline, count: result.skipped });
}

/**
 * Relaunches what the last quit's "Quit and Stop Tasks" ended. The Server consumes its record, so a repeated run only
 * reports that nothing is left; the local guard just keeps a double press from stacking progress toasts.
 */
export async function restoreQuitStoppedSessions(): Promise<void> {
    if (restore.running) return;
    restore.running = true;
    // Captured once so dismissal matches the exact text that was shown, even if the language changes meanwhile.
    const progressMessage = translate('session.quitRestore.progress');
    pushToast('info', progressMessage, { history: false });
    try {
        const result = await tryCommand(translate('session.quitRestore.failed'), () =>
            caxri.request('session.restoreQuitStopped', {}),
        );
        dismissToastsMatching((message) => message === progressMessage);
        if (result) pushToast(result.skipped > 0 ? 'warning' : 'info', describeQuitRestore(result));
    } finally {
        dismissToastsMatching((message) => message === progressMessage);
        restore.running = false;
    }
}
