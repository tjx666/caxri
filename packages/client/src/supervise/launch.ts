import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import process from 'node:process';

import type { AgentProvider } from '@caxri/protocol';
import {
    agentProviderIds,
    CaxriError,
    INSPECT_ENVIRONMENT_KEY,
    inspectExecArgv,
    LOG_LEVEL_ENVIRONMENT_KEY,
} from '@caxri/protocol';

import { resolveServerArtifact } from './artifact.js';

const AGENT_LAUNCH_ENVIRONMENT_KEYS: Record<AgentProvider, readonly string[]> = {
    grok: ['GROK_HOME'],
    claude: ['CLAUDE_CONFIG_DIR'],
    codex: ['CODEX_HOME', 'CODEX_SQLITE_HOME'],
};

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
    /**
     * Debugging controls the launcher must hand down, or the Hosts would silently keep their shipped defaults while the
     * operator believes the export took effect. `CAXRI_INSPECT` continues from Server Core to the Extension and
     * Terminal Hosts, which compute their own inspector ports from it.
     */
    LOG_LEVEL_ENVIRONMENT_KEY,
    INSPECT_ENVIRONMENT_KEY,
    ...agentProviderIds.flatMap((provider) => AGENT_LAUNCH_ENVIRONMENT_KEYS[provider]),
] as const;

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
            [...inspectExecArgv('server-core', environment), artifact.entryPath],
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
