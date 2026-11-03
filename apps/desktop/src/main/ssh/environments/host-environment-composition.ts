import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

import type { ServerEvent } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { BrowserWindow } from 'electron';
import { shell } from 'electron';

import type { MainMethodHandlerOptions } from '../../main-methods';
import { createMainMethodHandler } from '../../main-methods';
import { ProjectRootGrants } from '../../root-grants';
import { PRIMARY_WINDOW_KEY } from '../../window-presence-registry';
import { createWorkbenchRootAuthority } from '../../workbench-root-authority';
import { createSshHostSupervisor, SSH_CONFIG_ENVIRONMENT_KEY } from '../host-supervisor';
import { resolveSshHostWindowKey } from '../resolve-destination';
import { readSeedConfig } from '../seed-config';
import { listSshConfigHosts, RecentSshDestinations } from '../ssh-config';
import type { SshHostEnvironmentPartsOptions } from './host-environment-parts';
import { createSshHostEnvironmentParts } from './host-environment-parts';
import type { SshHostEnvironments } from './host-environments';
import { createSshHostEnvironments } from './host-environments';
import { HostPreferencesStore } from './host-preferences';
import type { PrimaryWindowChannel } from './primary-window-channel';

/**
 * Main method options that do not depend on which window asked: the local Workbench's process-wide controllers.
 */
type SharedMainMethodOptions = Pick<
    MainMethodHandlerOptions,
    | 'allowGpuTestInjection'
    | 'getCaxriBot'
    | 'getProcessExplorer'
    | 'getRemoteDebugging'
    | 'getUpdateService'
    | 'getUserDataPath'
    | 'injectGpuContextLoss'
    | 'restartInGpuSafeMode'
>;

export interface SshHostEnvironmentCompositionOptions {
    connection: SshHostEnvironmentPartsOptions['connection'];
    /**
     * Main's own output directory, used to find the built remote layers when unpackaged.
     */
    currentDirectory: string;
    isPackaged: boolean;
    logger: () => StructuredLogger;
    nextTestRoot: Parameters<typeof createWorkbenchRootAuthority>[0]['nextTestRoot'];
    primaryWindow: PrimaryWindowChannel;
    /**
     * Main's own event fan-out: the SSH Host list goes to the primary window, Host preferences to every window.
     */
    sendEvent: (event: ServerEvent, windowKey?: string) => void;
    shared: SharedMainMethodOptions;
    userDataPath: string;
    workbenchWindow: () => BrowserWindow | undefined;
}

/**
 * Builds the SSH Host registry. Each SSH Host gets its own Main method handler bound to its own Server connection,
 * guarded by `environmentMethodScopes`, and acting over the primary Workbench window.
 */
export function composeSshHostEnvironments(
    options: SshHostEnvironmentCompositionOptions,
): SshHostEnvironments {
    const recentDestinations = new RecentSshDestinations(options.userDataPath);
    const preferences = new HostPreferencesStore(join(options.userDataPath, 'ssh'), (payload) =>
        options.sendEvent({ event: 'sshHost.preferencesChanged', payload }),
    );
    const environments: SshHostEnvironments = createSshHostEnvironments({
        create: createSshHostEnvironmentParts({
            connection: options.connection,
            createMainHandler: (input) => {
                const methods = () => environments.methodsFor(input.environmentId);
                return createMainMethodHandler({
                    ...options.shared,
                    environment: {
                        cancel: () => methods().cancel(),
                        connect: (destination) => environments.connect(destination),
                        disconnect: () => methods().disconnect(),
                        get: () => methods().get(),
                        list: () => methods().list(),
                        listHosts: () => methods().listHosts(),
                        reconnect: () => methods().reconnect(),
                        retryNow: () => methods().retryNow(),
                        replyAskpass: (requestId, response) =>
                            methods().replyAskpass(requestId, response),
                        revealSshConfig: () => methods().revealSshConfig(),
                        stopServer: () => methods().stopServer(),
                        preferences: {
                            get: () => methods().preferences.get(),
                            update: (hostId, change) =>
                                methods().preferences.update(hostId, change),
                            setShowHostNames: (shouldShowHostNames) =>
                                methods().preferences.setShowHostNames(shouldShowHostNames),
                        },
                    },
                    logger: options.logger,
                    revealSessionInWorkbench: async (sessionId) => {
                        await input.connection.request('session.select', {
                            sessionId,
                            windowKey: PRIMARY_WINDOW_KEY,
                        });
                        await input.focusWindow();
                    },
                    openSettingsInWorkbench: async (target) => {
                        await input.focusWindow();
                        input.sendEvent(
                            target
                                ? { event: 'settings.openRequested', payload: { target } }
                                : {
                                      event: 'command.execute',
                                      payload: { command: 'settings.open', viaAccelerator: false },
                                  },
                        );
                    },
                    getSupervisor: () => input.connection,
                    getWindow: input.window,
                    sendEvent: input.sendEvent,
                    windowPresence: input.windowPresence,
                    workbenchRootAuthority: createWorkbenchRootAuthority({
                        environment: 'ssh',
                        focusWindow: input.focusWindow,
                        getServer: () => input.connection,
                        getWindow: input.window,
                        grants: new ProjectRootGrants(),
                        logger: options.logger,
                        nextTestRoot: options.nextTestRoot,
                    }),
                });
            },
            createSupervisor: (destination, hooks) =>
                createSshHostSupervisor({
                    destination,
                    electronExecutable: process.execPath,
                    hooks,
                    logger: options.logger(),
                    privateDirectory: join(options.userDataPath, 'ssh'),
                    // Packaging copies `apps/server/dist/remote` to `Contents/Resources/remote`.
                    remoteLayersRoot: options.isPackaged
                        ? join(process.resourcesPath, 'remote')
                        : resolve(options.currentDirectory, '../../apps/server/dist/remote'),
                    seedConfig: () => readSeedConfig(join(options.userDataPath, 'config')),
                }),
            deliver: (environmentId, message) =>
                options.primaryWindow.deliver(environmentId, message),
            logger: options.logger,
            observeWorkbenchWindow: (listener) => options.primaryWindow.observe(listener),
            whenAttached: (environmentId) => {
                const environment = environments.get(environmentId);
                return environment
                    ? environments.whenAttached(environment)
                    : Promise.reject(new CaxriError('CANCELLED', 'The SSH Host was disconnected'));
            },
            workbenchWindow: options.workbenchWindow,
        }),
        keyOf: (destination) => {
            const configFile = process.env[SSH_CONFIG_ENVIRONMENT_KEY];
            return resolveSshHostWindowKey(destination, configFile ? { configFile } : {});
        },
        listHosts: () => {
            // The same file every `ssh` call passes as `-F`, so the dialog lists the hosts it can actually reach.
            const configPath = process.env[SSH_CONFIG_ENVIRONMENT_KEY];
            return listSshConfigHosts(configPath ? { configPath } : {});
        },
        logger: options.logger,
        onEnvironmentsChanged: (payload) =>
            options.sendEvent(
                { event: 'sshHost.environmentsChanged', payload },
                PRIMARY_WINDOW_KEY,
            ),
        revealSshConfig,
        preferences,
        recent: {
            list: () => recentDestinations.list(),
            remember: async (destination) => {
                await recentDestinations.record(destination);
            },
        },
    });
    void reconnectOnLaunch(environments, preferences, options.logger);
    return environments;
}

/**
 * Connects every SSH Host whose Reconnect on Launch is on (the default) once Main starts, in the order they were first
 * connected. A Host that fails shows its failure in the side bar like any other connection.
 */
async function reconnectOnLaunch(
    environments: SshHostEnvironments,
    preferences: HostPreferencesStore,
    logger: () => StructuredLogger,
): Promise<void> {
    const { hosts } = await preferences.read();
    for (const host of Object.values(hosts)) {
        if (!host.destination || host.reconnectOnLaunch === false) continue;
        try {
            // One Host at a time, so two never ask for a passphrase together.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential on purpose; see above
            await environments.connect(host.destination); // eslint-disable-line no-await-in-loop -- see above
        } catch (error) {
            logger().write('warn', logEventCatalog.sshHost.reconnectOnLaunchFailed, {
                fields: { code: error instanceof CaxriError ? error.code : 'UNKNOWN' },
            });
        }
    }
}

async function isExistingPath(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Shows the SSH config every `ssh` call reads (the `CAXRI_SSH_CONFIG` override, else `~/.ssh/config`) in Finder. A
 * config that does not exist yet opens its folder instead, where the user creates it.
 */
async function revealSshConfig(): Promise<void> {
    const override = process.env[SSH_CONFIG_ENVIRONMENT_KEY];
    // An empty override means unset, as it does for `keyOf` and `listHosts` above.
    const configPath =
        override === undefined || override === '' ? join(homedir(), '.ssh', 'config') : override;
    if (await isExistingPath(configPath)) {
        shell.showItemInFolder(configPath);
        return;
    }
    const directory = dirname(configPath);
    if (!(await isExistingPath(directory)))
        throw new CaxriError('NOT_FOUND', 'The SSH config folder does not exist');
    const failure = await shell.openPath(directory);
    if (failure) throw new CaxriError('IO', failure);
}
