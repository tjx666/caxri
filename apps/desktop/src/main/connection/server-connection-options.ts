import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import process from 'node:process';

import type { E2EAgentPolicy } from '@caxri/system';
import { app } from 'electron';

import type { DesktopServerConnectionOptions } from './server-attachment';
import { resolveDesktopLaunch } from './server-launch-environment';

/**
 * Connection options that do not depend on which Server is attached. The local connection adds its command handler and
 * logger; an SSH Host connection reuses its build identity and local artifact (for the build fingerprint).
 */
export type SharedServerConnectionOptions = Omit<
    DesktopServerConnectionOptions,
    'createServerSupervisor' | 'discoverDesktop' | 'handleCommand' | 'logger'
>;

/**
 * Resolves the packaged or unpackaged CLI, Server artifact, Agent hooks, and relaunch command for this Desktop.
 */
export function resolveServerConnectionOptions(options: {
    currentDirectory: string;
    e2eAgentPolicy: E2EAgentPolicy | undefined;
    userDataPath: string;
    version: string;
}): SharedServerConnectionOptions {
    const { currentDirectory, userDataPath } = options;
    return {
        buildIdentity: {
            commit: process.env.CAXRI_GIT_COMMIT,
            version: options.version,
        },
        agentHooksPath:
            process.env.CAXRI_E2E === '1'
                ? process.env.CAXRI_E2E_AGENT_HOOKS === '1'
                    ? join(userDataPath, 'agent-hooks')
                    : undefined
                : join(app.getPath('appData'), 'caxri', 'agent-hooks'),
        currentDirectory,
        cliPath: app.isPackaged
            ? join(process.resourcesPath, 'cli', 'caxri.cjs')
            : resolve(currentDirectory, '../../apps/cli/dist/caxri.cjs'),
        desktopId: randomUUID(),
        desktopLaunch: resolveDesktopLaunch({
            currentDirectory,
            executable: process.execPath,
            isPackaged: app.isPackaged,
        }),
        e2eAgentPolicy: options.e2eAgentPolicy,
        serverArtifactRoot: app.isPackaged
            ? join(process.resourcesPath, 'server')
            : resolve(currentDirectory, '../../apps/server/dist/server'),
        userDataPath,
    };
}
