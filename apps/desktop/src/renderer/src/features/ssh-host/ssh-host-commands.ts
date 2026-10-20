import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { getSshEnvironment } from '../../stores/environment';
import { tryCommand } from '../../stores/toasts';
import { setConnectSshHostOpen, useSshHostDialogsStore } from './ssh-host-dialogs-store';

export function openConnectSshHostDialog(): void {
    setConnectSshHostOpen(true);
}

/**
 * Opens (or focuses) the SSH Host's own window. The picker stays open with this destination pending until Main answers,
 * because resolving a destination it has not seen yet runs `ssh -G`, which a slow `Match exec` can hold for seconds.
 * The connection itself then reports its progress inside that window. A second choice while one is pending is ignored.
 */
export async function connectToSshHost(destination: string): Promise<void> {
    if (useSshHostDialogsStore.getState().connectingDestination !== undefined) return;
    useSshHostDialogsStore.setState({ connectingDestination: destination });
    try {
        await tryCommand(translate('sshHost.connect.failed'), () =>
            caxri.request('sshHost.connect', { destination }),
        );
    } finally {
        // The user may have closed the picker meanwhile; only the picker still waiting on this connect closes.
        if (useSshHostDialogsStore.getState().connectingDestination === destination)
            setConnectSshHostOpen(false);
    }
}

export async function reconnectSshHost(): Promise<void> {
    await tryCommand(translate('sshHost.reconnect.failed'), () =>
        caxri.request('sshHost.reconnect'),
    );
}

/**
 * Ends the wait before the next automatic reconnect attempt so it starts now.
 */
export async function retrySshHostNow(): Promise<void> {
    await tryCommand(translate('sshHost.retryNow.failed'), () => caxri.request('sshHost.retryNow'));
}

/**
 * Stops the connect, install, or reconnect in progress; the window stays open so Reconnect can start over.
 */
export async function cancelSshHostConnection(): Promise<void> {
    await tryCommand(translate('sshHost.cancel.failed'), () => caxri.request('sshHost.cancel'));
}

/**
 * Shows the SSH config the picker lists hosts from, so the user can add a `Host` entry.
 */
export async function revealSshConfig(): Promise<void> {
    await tryCommand(translate('sshHost.connect.openConfigFailed'), () =>
        caxri.request('sshHost.sshConfig.reveal'),
    );
}

/**
 * Stopping the SSH Host's Server ends every Terminal and Agent it runs, so it is confirmed first. Main closes this
 * window once the Server has stopped.
 */
export async function stopSshHostServer(): Promise<void> {
    const environment = getSshEnvironment();
    if (!environment) return;
    const isConfirmed = await caxri.window.showConfirm({
        title: translate('sshHost.stop.title', { destination: environment.destination }),
        message: translate('sshHost.stop.message'),
        confirmLabel: translate('sshHost.stop.confirm'),
    });
    if (!isConfirmed) return;
    await tryCommand(translate('sshHost.stop.failed'), () => caxri.request('sshHost.stopServer'));
}

/**
 * Answers OpenSSH's pending prompt; `null` cancels it. Resolves `false` when the answer never reached Main, so the
 * prompt can be answered again. The response goes straight to Main and is never logged, kept, or echoed here: the
 * failure toast names the action only.
 */
export async function didReplySshHostPrompt(
    requestId: string,
    response: string | null,
): Promise<boolean> {
    const isDelivered = await tryCommand(translate('sshHost.askpass.failed'), async () => {
        await caxri.request('sshHost.askpass.reply', { requestId, response });
        return true;
    });
    return isDelivered === true;
}
