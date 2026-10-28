import type { TerminalPtyAlert } from '@caxri/protocol';

import { translate } from '../../i18n';
import { isLocalOnlyAvailable } from '../../stores/environment';
import { dismissToastsMatching, pushToast } from '../../stores/toasts';

/**
 * The message of the live PTY alert, so a `cleared` event retracts exactly the toast it raised. It embeds the readings,
 * which differ between episodes, so it cannot be rebuilt from the cleared event.
 */
const live: { message?: string } = {};

export function terminalPtyAlertMessage(alert: Pick<TerminalPtyAlert, 'inUse' | 'limit'>): string {
    return translate('terminal.ptyAlert.message', { inUse: alert.inUse, limit: alert.limit });
}

function dismissLivePtyAlert(): void {
    const { message } = live;
    live.message = undefined;
    if (message) dismissToastsMatching((title) => title === message);
}

/**
 * Warns that the machine is close to running out of PTY slots, after which no new Terminal (in Caxri or any other app)
 * can start. The notice persists until dismissed or the Server reports use back down, because the slots stay taken
 * until someone closes Terminals.
 */
export function reportTerminalPtyAlert(alert: TerminalPtyAlert): void {
    dismissLivePtyAlert();
    if (alert.state === 'cleared') return;
    const message = terminalPtyAlertMessage(alert);
    live.message = message;
    pushToast('warning', message, {
        persist: true,
        // Process Explorer lists this Mac's processes, not the SSH Host's.
        action: isLocalOnlyAvailable() ? { id: 'processExplorer.open' } : undefined,
    });
}
