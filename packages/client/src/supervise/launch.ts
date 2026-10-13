import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import process from 'node:process';

import {
    CaxriError,
    INHERITED_PROCESS_ENVIRONMENT_KEYS,
    INSPECT_ENVIRONMENT_KEY,
    inspectExecArgv,
    LOG_LEVEL_ENVIRONMENT_KEY,
    SERVER_CORE_EXEC_ARGV,
} from '@caxri/protocol';

import { resolveServerArtifact } from './artifact.js';

/**
 * Server Core rebuilds its children's environment from its own (`safeProcessEnvironment` in `@caxri/system`), so a key
 * missing here never reaches an Agent provider, Git, or a Terminal. The launcher therefore forwards the complete shared
 * inherited list rather than a narrower copy of it.
 */
const LAUNCH_ENVIRONMENT_KEYS = [
    ...INHERITED_PROCESS_ENVIRONMENT_KEYS,
    /**
     * Debugging controls the launcher must hand down, or a Host would keep the defaults (debug logging, an open
     * inspector port) while the operator believes their narrowing export took effect. `CAXRI_INSPECT` continues from
     * Server Core to the Extension and Terminal Hosts, which compute their own inspector ports from it.
     */
    LOG_LEVEL_ENVIRONMENT_KEY,
    INSPECT_ENVIRONMENT_KEY,
];

export interface ServerLaunchOptions {
    /**
     * Root of the immutable standalone Server directory artifact.
     */
    artifactRoot: string;
    environment?: NodeJS.ProcessEnv;
}

export interface ServerLaunchReceipt {
    pid: number;
}

function safeLaunchEnvironment(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const key of LAUNCH_ENVIRONMENT_KEYS)
        if (process.env[key] !== undefined) environment[key] = process.env[key];
    return { ...environment, ...overrides };
}

export async function launchServer(
    userDataPath: string,
    options: ServerLaunchOptions,
): Promise<ServerLaunchReceipt> {
    await mkdir(userDataPath, { recursive: true });
    const artifact = await resolveServerArtifact(options.artifactRoot);
    /**
     * Resolved before the spawn because the inspector flag and the child's environment must agree on one answer: the
     * allow-list decides whether `CAXRI_INSPECT` survives into the child at all, and that same value decides whether
     * this Server Core gets an inspector port.
     */
    const environment = {
        ...safeLaunchEnvironment(options.environment),
        CAXRI_USER_DATA_PATH: userDataPath,
    };
    return new Promise<ServerLaunchReceipt>((resolve, reject) => {
        const child = spawn(
            artifact.executablePath,
            [
                ...SERVER_CORE_EXEC_ARGV,
                ...inspectExecArgv('server-core', environment),
                artifact.entryPath,
            ],
            { detached: true, env: environment, stdio: 'ignore' },
        );
        child.once('error', () =>
            reject(new CaxriError('UNAVAILABLE', 'Caxri Host process failed to launch')),
        );
        child.once('spawn', () => {
            if (child.pid === undefined) {
                reject(new CaxriError('UNAVAILABLE', 'Caxri Host process failed to launch'));
                return;
            }
            child.unref();
            resolve({ pid: child.pid });
        });
    });
}
