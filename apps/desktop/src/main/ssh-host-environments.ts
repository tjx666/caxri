import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { shell } from 'electron';

import type { MainMethodHandlerOptions } from './main-methods';
import { createMainMethodHandler } from './main-methods';
import type { RemoteEnvironmentWindowOptions } from './remote-environment-window';
import { createRemoteEnvironmentParts } from './remote-environment-window';
import type { RemoteEnvironments } from './remote-environments';
import { createRemoteEnvironments } from './remote-environments';
import { loadRendererEntry } from './renderer-entry';
import { ProjectRootGrants } from './root-grants';
import {
    createRemoteHostSupervisor,
    SSH_CONFIG_ENVIRONMENT_KEY,
} from './ssh/remote-host-supervisor';
import type { RemoteSeedConfig } from './ssh/remote-server-supervisor-options';
import { resolveSshHostWindowKey } from './ssh/resolve-destination';
import { listSshConfigHosts, RecentSshDestinations } from './ssh/ssh-config';
import { mainWindowChromeOptions, zoomFactorForLevel } from './window-chrome';
import { createWorkbenchRootAuthority } from './workbench-root-authority';

/**
 * Main method options that do not depend on which window asked: the local Workbench's process-wide controllers.
 */
type SharedMainMethodOptions = Pick<
    MainMethodHandlerOptions,
    | 'allowGpuTestInjection'
    | 'getAgentCommander'
    | 'getProcessExplorer'
    | 'getRemoteDebugging'
    | 'getUpdateService'
    | 'getUserDataPath'
    | 'injectGpuContextLoss'
    | 'restartInGpuSafeMode'
>;

export interface SshHostEnvironmentsOptions {
    connection: RemoteEnvironmentWindowOptions['connection'];
    /**
     * Main's own output directory, used to find the Renderer entry and, unpackaged, the built remote layers.
     */
    currentDirectory: string;
    isPackaged: boolean;
    isQuitting: () => boolean;
    logger: () => StructuredLogger;
    nextTestRoot: Parameters<typeof createWorkbenchRootAuthority>[0]['nextTestRoot'];
    shared: SharedMainMethodOptions;
    userDataPath: string;
    /**
     * The Workbench zoom level, shared by every window.
     */
    zoomLevel(): number;
}

/**
 * Builds the SSH Host registry. Each SSH Host window gets its own Main method handler bound to its own Server
 * connection and window, guarded by `environmentMethodScopes`.
 */
export function createSshHostEnvironments(options: SshHostEnvironmentsOptions): RemoteEnvironments {
    const recentDestinations = new RecentSshDestinations(options.userDataPath);
    const environments: RemoteEnvironments = createRemoteEnvironments({
        create: createRemoteEnvironmentParts({
            chrome: () => {
                const zoomFactor = zoomFactorForLevel(options.zoomLevel());
                return {
                    ...mainWindowChromeOptions(zoomFactor),
                    webPreferences: {
                        preload: join(options.currentDirectory, '../preload/index.cjs'),
                        contextIsolation: true,
                        nodeIntegration: false,
                        sandbox: true,
                        zoomFactor,
                    },
                };
            },
            connection: options.connection,
            createMainHandler: (input) => {
                const methods = () => environments.methodsFor(input.window()?.webContents);
                return createMainMethodHandler({
                    ...options.shared,
                    environment: {
                        cancel: () => methods().cancel(),
                        connect: (destination) => environments.connect(destination),
                        get: () => methods().get(),
                        listHosts: () => methods().listHosts(),
                        reconnect: () => methods().reconnect(),
                        replyAskpass: (requestId, response) =>
                            methods().replyAskpass(requestId, response),
                        revealSshConfig: () => methods().revealSshConfig(),
                        stopServer: () => methods().stopServer(),
                    },
                    logger: options.logger,
                    onUnsavedEditorsReply: input.onUnsavedEditorsReply,
                    revealSessionInWorkbench: async (sessionId) => {
                        await input.connection.request('session.select', { sessionId });
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
                createRemoteHostSupervisor({
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
            isQuitting: options.isQuitting,
            loadRenderer: (window) =>
                loadRendererEntry(window, {
                    currentDirectory: options.currentDirectory,
                    isPackaged: options.isPackaged,
                    page: 'index.html',
                    rendererUrl: process.env.ELECTRON_RENDERER_URL,
                }),
            logger: options.logger,
            whenAttached: (window) => {
                const environment = environments.forWindow(window);
                return environment
                    ? environments.whenAttached(environment)
                    : Promise.reject(new CaxriError('CANCELLED', 'The SSH Host window was closed'));
            },
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
        revealSshConfig,
        recent: {
            list: () => recentDestinations.list(),
            remember: async (destination) => {
                await recentDestinations.record(destination);
            },
        },
    });
    return environments;
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

async function readOptionalFile(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, 'utf8');
    } catch {
        return undefined;
    }
}

/**
 * Reads the local profile's settings, keybindings, and theme so a first connect to an SSH Host starts from the same
 * Workbench. A missing file is skipped; the SSH Host never overwrites a file it already has.
 */
async function readSeedConfig(configDirectory: string): Promise<RemoteSeedConfig> {
    const [settings, keybindings, theme] = await Promise.all([
        readOptionalFile(join(configDirectory, 'settings.jsonc')),
        readOptionalFile(join(configDirectory, 'keybindings.jsonc')),
        readOptionalFile(join(configDirectory, 'theme.json')),
    ]);
    return { keybindings, settings, theme };
}
