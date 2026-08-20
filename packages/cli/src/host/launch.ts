import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import process from 'node:process';

import { CaxriError } from '@caxri/protocol';

const LAUNCH_ENVIRONMENT_KEYS = [
    'HOME',
    'USER',
    'LOGNAME',
    'PATH',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'SSH_AUTH_SOCK',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'CODEX_HOME',
    'CODEX_SQLITE_HOME',
    'CLAUDE_CONFIG_DIR',
] as const;

export interface HostLaunchOptions {
    /**
     * Electron binary, or the packaged Caxri executable with the RunAsNode fuse enabled.
     */
    executable: string;
    /**
     * Built `host.js`, including an app.asar path for the packaged Desktop shim.
     */
    entryPath: string;
    environment?: NodeJS.ProcessEnv;
}

function safeLaunchEnvironment(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const key of LAUNCH_ENVIRONMENT_KEYS)
        if (process.env[key] !== undefined) environment[key] = process.env[key];
    return { ...environment, ...overrides };
}

export async function launchHost(userDataPath: string, options: HostLaunchOptions): Promise<void> {
    await mkdir(userDataPath, { recursive: true });
    await new Promise<void>((resolve, reject) => {
        const child = spawn(options.executable, [options.entryPath], {
            detached: true,
            env: {
                ...safeLaunchEnvironment(options.environment),
                CAXRI_USER_DATA_PATH: userDataPath,
                ELECTRON_RUN_AS_NODE: '1',
            },
            stdio: 'ignore',
        });
        child.once('error', () =>
            reject(new CaxriError('UNAVAILABLE', 'Caxri Host process failed to launch')),
        );
        child.once('spawn', () => {
            child.unref();
            resolve();
        });
    });
}
