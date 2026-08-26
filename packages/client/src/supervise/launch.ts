import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import process from 'node:process';

import type { AgentProvider } from '@caxri/protocol';
import { agentProviderIds, CaxriError } from '@caxri/protocol';

import { resolveServerArtifact } from './artifact.js';

const AGENT_LAUNCH_ENVIRONMENT_KEYS: Record<AgentProvider, readonly string[]> = {
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
    ...agentProviderIds.flatMap((provider) => AGENT_LAUNCH_ENVIRONMENT_KEYS[provider]),
] as const;

export interface ServerLaunchOptions {
    /**
     * Root of the immutable standalone Server directory artifact.
     */
    artifactRoot: string;
    environment?: NodeJS.ProcessEnv;
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
): Promise<void> {
    await mkdir(userDataPath, { recursive: true });
    const artifact = await resolveServerArtifact(options.artifactRoot);
    await new Promise<void>((resolve, reject) => {
        const child = spawn(artifact.executablePath, [artifact.entryPath], {
            detached: true,
            env: {
                ...safeLaunchEnvironment(options.environment),
                CAXRI_USER_DATA_PATH: userDataPath,
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
