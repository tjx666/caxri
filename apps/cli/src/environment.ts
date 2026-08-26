import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';

import { CaxriError, hostCredentialTokenSchema, hostProcessIdentitySchema } from '@caxri/protocol';
import { z } from 'zod';

export type CliAutomation = 'agent' | 'ci' | 'human';

function isEnabled(value: string | undefined): boolean {
    return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

export function detectAutomation(environment: NodeJS.ProcessEnv): CliAutomation {
    if (isEnabled(environment.CI) || isEnabled(environment.GITHUB_ACTIONS)) return 'ci';
    if (
        isEnabled(environment.CODEX_THREAD_ID) ||
        isEnabled(environment.CLAUDECODE) ||
        isEnabled(environment.CLAUDE_CODE_ENTRYPOINT)
    )
        return 'agent';
    return 'human';
}

export interface ResolvedProfile {
    path: string;
    source: 'argument' | 'environment' | 'default';
}

const agentEndpointEnvironmentSchema = z.object({
    CAXRI_AGENT_ENDPOINT_HOST_ID: hostProcessIdentitySchema,
    CAXRI_AGENT_ENDPOINT_ID: z.string().min(1).max(200),
    CAXRI_AGENT_ENDPOINT_GENERATION: z.coerce.number().int().positive(),
    CAXRI_AGENT_ENDPOINT_TOKEN: hostCredentialTokenSchema,
});

export interface AgentEndpointCredential {
    kind: 'agent';
    hostId: string;
    endpointId: string;
    generation: number;
    token: string;
}

export interface PackagedServerLaunch {
    artifactRoot: string;
}

/**
 * Derives launch authority only from the currently executing packaged Caxri application layout.
 */
export function resolvePackagedServerLaunch(input: {
    executable: string;
    resourcesPath?: string;
    runAsNode?: string;
    scriptPath?: string;
}): PackagedServerLaunch | undefined {
    if (input.runAsNode !== '1' || !input.resourcesPath || !input.scriptPath) return undefined;
    const resourcesPath = resolve(input.resourcesPath);
    const executable = resolve(resourcesPath, '..', 'MacOS', 'Caxri');
    const cliBundle = resolve(resourcesPath, 'cli', 'caxri.cjs');
    if (resolve(input.executable) !== executable || resolve(input.scriptPath) !== cliBundle)
        return undefined;
    return { artifactRoot: resolve(resourcesPath, 'server') };
}

/**
 * Requires the complete generation credential; partial inherited state is never authoritative.
 */
export function resolveAgentEndpointCredential(
    environment: NodeJS.ProcessEnv,
): AgentEndpointCredential | undefined {
    const present = [
        environment.CAXRI_AGENT_ENDPOINT_HOST_ID,
        environment.CAXRI_AGENT_ENDPOINT_ID,
        environment.CAXRI_AGENT_ENDPOINT_GENERATION,
        environment.CAXRI_AGENT_ENDPOINT_TOKEN,
    ];
    if (present.every((value) => value === undefined)) return undefined;
    const parsed = agentEndpointEnvironmentSchema.safeParse(environment);
    if (!parsed.success)
        throw new CaxriError('VALIDATION', 'Agent Endpoint environment is incomplete or invalid');
    return {
        kind: 'agent',
        hostId: parsed.data.CAXRI_AGENT_ENDPOINT_HOST_ID,
        endpointId: parsed.data.CAXRI_AGENT_ENDPOINT_ID,
        generation: parsed.data.CAXRI_AGENT_ENDPOINT_GENERATION,
        token: parsed.data.CAXRI_AGENT_ENDPOINT_TOKEN,
    };
}

function defaultProfilePath(
    platform: NodeJS.Platform,
    home: string,
    environment: NodeJS.ProcessEnv,
): string {
    if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Caxri');
    if (platform === 'win32') return join(environment.APPDATA ?? home, 'Caxri');
    return join(environment.XDG_CONFIG_HOME ?? join(home, '.config'), 'Caxri');
}

export function resolveCliProfile(options: {
    environment: NodeJS.ProcessEnv;
    explicit?: string;
    home?: string;
    platform?: NodeJS.Platform;
}): ResolvedProfile {
    const environmentPath = options.environment.CAXRI_USER_DATA_DIR;
    const selected = options.explicit ?? environmentPath;
    if (selected !== undefined) {
        if (!isAbsolute(selected))
            throw new CaxriError('VALIDATION', 'The profile selector must be an absolute path');
        return { path: selected, source: options.explicit ? 'argument' : 'environment' };
    }
    return {
        path: defaultProfilePath(
            options.platform ?? process.platform,
            options.home ?? homedir(),
            options.environment,
        ),
        source: 'default',
    };
}
