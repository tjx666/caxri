import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { getSshEnvironment } from '../../stores/environment';
import { tryCommand } from '../../stores/toasts';
import { setConnectSshHostOpen } from './ssh-host-dialogs-store';

export function openConnectSshHostDialog(): void {
    setConnectSshHostOpen(true);
}

/**
 * Opens (or focuses) the SSH Host's own window. Main returns as soon as the window exists; the connection itself
 * reports its progress inside that window, so this window has nothing further to wait for.
 */
export async function connectToSshHost(destination: string): Promise<void> {
    setConnectSshHostOpen(false);
    await tryCommand(translate('sshHost.connect.failed'), () =>
        caxri.request('remote.connect', { destination }),
    );
}

export async function reconnectSshHost(): Promise<void> {
    await tryCommand(translate('sshHost.reconnect.failed'), () =>
        caxri.request('remote.reconnect'),
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
    await tryCommand(translate('sshHost.stop.failed'), () => caxri.request('remote.stopServer'));
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
        await caxri.request('remote.askpass.reply', { requestId, response });
        return true;
    });
    return isDelivered === true;
}
