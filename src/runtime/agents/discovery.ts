import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import { agentProviderCatalog, agentProviderIds, type AgentProviderId } from '../../shared/agents';
import { safeProcessEnvironment } from '../../shared/node/process-environment';
import type { AgentProvider } from '../../shared/types';

const execFileAsync = promisify(execFile);

const executableNames: Record<AgentProviderId, string> = Object.fromEntries(
    agentProviderIds.map((provider) => [provider, agentProviderCatalog[provider].executableName]),
) as Record<AgentProviderId, string>;

const executableCache = new Map<AgentProvider, string>();
const executableRequests = new Map<AgentProvider, Promise<string | undefined>>();
const versionCache = new Map<AgentProvider, { executable: string; version: string }>();

async function isExecutable(path: string): Promise<boolean> {
    try {
        await access(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

export function clearExecutableCache(): void {
    executableCache.clear();
    executableRequests.clear();
    versionCache.clear();
}

export async function discoverExecutable(name: AgentProvider): Promise<string | undefined> {
    const cached = executableCache.get(name);
    if (cached && (await isExecutable(cached))) return cached;
    executableCache.delete(name);
    const pending = executableRequests.get(name);
    if (pending) return pending;
    const request = findExecutable(name).finally(() => executableRequests.delete(name));
    executableRequests.set(name, request);
    const executable = await request;
    if (executable) executableCache.set(name, executable);
    return executable;
}

async function findExecutable(name: AgentProvider): Promise<string | undefined> {
    for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
        const candidate = join(directory, executableNames[name]);
        if (await isExecutable(candidate)) return candidate;
    }

    const shell = process.env.SHELL || '/bin/zsh';
    try {
        const { stdout } = await execFileAsync(
            shell,
            ['-lic', `command -v ${executableNames[name]}`],
            {
                env: safeProcessEnvironment(),
                timeout: 5_000,
                maxBuffer: 8 * 1024,
            },
        );
        const candidate = stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .at(-1);
        if (!candidate || !isAbsolute(candidate) || !(await isExecutable(candidate)))
            return undefined;
        return candidate;
    } catch {
        return undefined;
    }
}

export async function readVersion(
    provider: AgentProvider,
    executable: string,
): Promise<string | undefined> {
    const cached = versionCache.get(provider);
    if (cached?.executable === executable) return cached.version;
    try {
        const { stdout, stderr } = await execFileAsync(executable, ['--version'], {
            env: safeProcessEnvironment(),
            timeout: 5_000,
            maxBuffer: 64 * 1024,
        });
        const version = (stdout || stderr).trim();
        if (version) versionCache.set(provider, { executable, version });
        return version || undefined;
    } catch {
        return undefined;
    }
}
