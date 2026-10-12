import type { CommandId } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { BaseWindow, BrowserWindow } from 'electron';

import type { MainEnvironmentMethods } from './main-environment-methods';
import { unconfiguredEnvironment } from './main-environment-methods';
import type { RemoteEnvironments } from './remote-environments';

/**
 * The local Workbench's `environment.*` and `remote.*` methods. It is always the local environment; it reaches the SSH
 * Host registry only to open a new SSH Host window or list hosts for the connect dialog. The registry is created once
 * Main's logger and local connection options exist, so `connect` fails as still starting until then.
 */
export function createLocalWorkbenchEnvironment(
    remoteEnvironments: () => RemoteEnvironments | undefined,
): MainEnvironmentMethods {
    return {
        ...unconfiguredEnvironment,
        connect: async (destination) => {
            const environments = remoteEnvironments();
            if (!environments) throw new CaxriError('UNAVAILABLE', 'Caxri is still starting');
            await environments.connect(destination);
        },
        listHosts: () =>
            remoteEnvironments()?.methodsFor(undefined).listHosts() ??
            Promise.resolve({ hosts: [], recent: [] }),
    };
}

/**
 * Routes an application menu command to the focused SSH Host window, which is a full Workbench of its own. Returns
 * `false` when `window` is not an SSH Host window, so the menu falls back to the local Workbench.
 */
export function createRemoteWindowCommandDispatcher(
    remoteEnvironments: () => RemoteEnvironments | undefined,
): (window: BaseWindow, command: CommandId, isViaAccelerator: boolean) => boolean {
    return (window, command, isViaAccelerator) => {
        const environment = remoteEnvironments()?.forWindow(window as BrowserWindow);
        if (!environment) return false;
        environment.sendEvent({
            event: 'command.execute',
            payload: { command, viaAccelerator: isViaAccelerator },
        });
        return true;
    };
}
