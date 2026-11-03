import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { environmentOfProject } from '../../lib/environment-routing';
import { environmentIdOf, findHost, useEnvironmentStore } from '../../stores/environment';
import { getBootstrap } from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import { chooseProjectFolder } from '../session/session-creation-commands';
import { isConnectionSettled } from './connection-status';
import { setConnectSshHostOpen, useSshHostDialogsStore } from './ssh-host-dialogs-store';

export function openConnectSshHostDialog(): void {
    setConnectSshHostOpen(true);
}

/**
 * Connects an SSH Host to this window, or reuses its existing connection, and answers its id. The picker stays open
 * with this destination pending until Main answers, because resolving a destination it has not seen yet runs `ssh -G`,
 * which a slow `Match exec` can hold for seconds. The connection then reports its progress in the side bar. A second
 * choice while one is pending is ignored. A Host with no Project yet asks for its first folder once it is connected
 * (`offerFirstProject`).
 */
export async function connectToSshHost(destination: string): Promise<string | undefined> {
    if (useSshHostDialogsStore.getState().connectingDestination !== undefined) return undefined;
    useSshHostDialogsStore.setState({ connectingDestination: destination });
    try {
        const connected = await tryCommand(translate('sshHost.connect.failed'), () =>
            caxri.in(undefined).request('sshHost.connect', { destination }),
        );
        if (connected) void offerFirstProject(connected.environmentId);
        return connected?.environmentId;
    } finally {
        // The user may have closed the picker meanwhile; only the picker still waiting on this connect closes.
        if (useSshHostDialogsStore.getState().connectingDestination === destination)
            setConnectSshHostOpen(false);
    }
}

/**
 * Resolves `true` once the SSH Host is connected, or `false` once it gave up or was disconnected.
 */
function whenConnected(environmentId: string): Promise<boolean> {
    return new Promise((resolve) => {
        const didSettle = (): boolean => {
            const host = findHost(environmentId);
            if (host?.phase === 'connected') resolve(true);
            else if (!host || isConnectionSettled(host.phase) || host.phase === 'stopped')
                resolve(false);
            else return false;
            return true;
        };
        if (didSettle()) return;
        const unsubscribe = useEnvironmentStore.subscribe(() => {
            if (didSettle()) unsubscribe();
        });
    });
}

/**
 * Opens the folder picker of a just-connected SSH Host that has no Project yet, so connecting leads straight to work
 * there instead of to a Host the side bar cannot show. A Host that already has Projects only joins the side bar.
 */
async function offerFirstProject(environmentId: string): Promise<void> {
    if (!(await whenConnected(environmentId))) return;
    await refreshWorkbench();
    const projects = getBootstrap()?.projects ?? [];
    if (projects.some((project) => environmentOfProject(project.id) === environmentId)) return;
    await chooseProjectFolder(environmentId);
}

export async function reconnectSshHost(environmentId: string): Promise<void> {
    await tryCommand(translate('sshHost.reconnect.failed'), () =>
        caxri.in(environmentId).request('sshHost.reconnect'),
    );
}

/**
 * Detaches one SSH Host from this Mac. Its Server keeps running there with its Terminals and Agents, and its Projects
 * leave the side bar until it is connected again.
 */
export async function disconnectSshHost(environmentId: string): Promise<void> {
    await tryCommand(translate('sshHost.disconnect.failed'), () =>
        caxri.in(environmentId).request('sshHost.disconnect'),
    );
}

/**
 * Ends the wait before the next automatic reconnect attempt so it starts now.
 */
export async function retrySshHostNow(environmentId: string): Promise<void> {
    await tryCommand(translate('sshHost.retryNow.failed'), () =>
        caxri.in(environmentId).request('sshHost.retryNow'),
    );
}

/**
 * Stops the connect, install, or reconnect in progress; the Host stays listed so Reconnect can start over.
 */
export async function cancelSshHostConnection(environmentId: string): Promise<void> {
    await tryCommand(translate('sshHost.cancel.failed'), () =>
        caxri.in(environmentId).request('sshHost.cancel'),
    );
}

/**
 * Shows the SSH config the picker lists hosts from, so the user can add a `Host` entry.
 */
export async function revealSshConfig(): Promise<void> {
    await tryCommand(translate('sshHost.connect.openConfigFailed'), () =>
        caxri.in(undefined).request('sshHost.sshConfig.reveal'),
    );
}

/**
 * Stopping the SSH Host's Server ends every Terminal and Agent it runs, so it is confirmed first. Main disconnects the
 * Host once its Server has stopped.
 */
export async function stopSshHostServer(environmentId: string): Promise<void> {
    const environment = findHost(environmentId);
    if (!environment) return;
    const isConfirmed = await caxri.window.showConfirm({
        title: translate('sshHost.stop.title', { destination: environment.destination }),
        message: translate('sshHost.stop.message'),
        confirmLabel: translate('sshHost.stop.confirm'),
    });
    if (!isConfirmed) return;
    await tryCommand(translate('sshHost.stop.failed'), () =>
        caxri.in(environmentIdOf(environment)).request('sshHost.stopServer'),
    );
}

/**
 * Answers OpenSSH's pending prompt; `null` cancels it. Resolves `false` when the answer never reached Main, so the
 * prompt can be answered again. The response goes straight to Main and is never logged, kept, or echoed here: the
 * failure toast names the action only.
 */
export async function didReplySshHostPrompt(
    environmentId: string,
    requestId: string,
    response: string | null,
): Promise<boolean> {
    const isDelivered = await tryCommand(translate('sshHost.askpass.failed'), async () => {
        await caxri.in(environmentId).request('sshHost.askpass.reply', { requestId, response });
        return true;
    });
    return isDelivered === true;
}
