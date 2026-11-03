import { CaxriError } from '@caxri/protocol';

import type { MainEnvironmentMethods } from './main-environment-methods';
import { unconfiguredEnvironment } from './main-environment-methods';
import type { SshHostEnvironments } from './ssh/environments/host-environments';
import { currentRequestWindowKey, PRIMARY_WINDOW_KEY } from './window-presence-registry';

/**
 * The local Workbench's `environment.*` and `sshHost.*` methods. It is always the local environment; it reaches the SSH
 * Host registry to connect a Host, list the connected ones, and list hosts for the connect dialog. The registry is
 * created once Main's logger and local connection options exist, so `connect` fails as still starting until then.
 */
export function createLocalWorkbenchEnvironment(
    sshHostEnvironments: () => SshHostEnvironments | undefined,
): MainEnvironmentMethods {
    return {
        ...unconfiguredEnvironment,
        connect: async (destination) => {
            const environments = sshHostEnvironments();
            if (!environments) throw new CaxriError('UNAVAILABLE', 'Caxri is still starting');
            return environments.connect(destination);
        },
        /**
         * Only the primary Workbench window lists SSH Hosts; a tear-off window shows one of this Mac's Sessions.
         */
        list: () =>
            currentRequestWindowKey() === PRIMARY_WINDOW_KEY
                ? (sshHostEnvironments()?.methodsFor(undefined).list() ?? [])
                : [],
        listHosts: () =>
            sshHostEnvironments()?.methodsFor(undefined).listHosts() ??
            Promise.resolve({ hosts: [], recent: [] }),
        preferences: {
            get: () =>
                sshHostEnvironments()?.methodsFor(undefined).preferences.get() ??
                unconfiguredEnvironment.preferences.get(),
            update: (hostId, change) => {
                const environments = sshHostEnvironments();
                if (!environments) throw new CaxriError('UNAVAILABLE', 'Caxri is still starting');
                return environments.methodsFor(undefined).preferences.update(hostId, change);
            },
            setShowHostNames: (shouldShowHostNames) => {
                const environments = sshHostEnvironments();
                if (!environments) throw new CaxriError('UNAVAILABLE', 'Caxri is still starting');
                return environments
                    .methodsFor(undefined)
                    .preferences.setShowHostNames(shouldShowHostNames);
            },
        },
        revealSshConfig: async () => {
            const environments = sshHostEnvironments();
            if (!environments) throw new CaxriError('UNAVAILABLE', 'Caxri is still starting');
            await environments.methodsFor(undefined).revealSshConfig();
        },
    };
}
