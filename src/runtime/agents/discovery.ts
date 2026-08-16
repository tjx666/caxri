import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { AgentProvider } from '../../shared/agents';
import { agentProviderCatalog, agentProviderIds } from '../../shared/agents';
import { readE2EAgentPolicy, selectE2EAgentExecutable } from '../../shared/node/e2e-agent-policy';
import {
    clearRuntimeExecutableCache,
    resolveRuntimeExecutable,
    runtimeProcessEnvironment,
} from '../executables';

const executableNames: Record<AgentProvider, string> = Object.fromEntries(
    agentProviderIds.map((provider) => [provider, agentProviderCatalog[provider].executableName]),
) as Record<AgentProvider, string>;

const execFileAsync = promisify(execFile);
const executableRequests = new Map<string, Promise<string | undefined>>();
const versionCache = new Map<AgentProvider, { executable: string; version: string }>();

export function clearExecutableCache(): void {
    clearRuntimeExecutableCache();
    executableRequests.clear();
    versionCache.clear();
}

export async function discoverExecutable(
    name: AgentProvider,
    requestedExecutable = executableNames[name],
): Promise<string | undefined> {
    const selectedExecutable = selectE2EAgentExecutable(
        readE2EAgentPolicy(),
        name,
        requestedExecutable,
    );
    if (!selectedExecutable) return undefined;
    const requestKey = `${name}:${selectedExecutable}`;
    const pending = executableRequests.get(requestKey);
    if (pending) return pending;
    const request = resolveRuntimeExecutable(selectedExecutable);
    executableRequests.set(requestKey, request);
    try {
        return await request;
    } finally {
        executableRequests.delete(requestKey);
    }
}

export async function readVersion(
    provider: AgentProvider,
    executable: string,
): Promise<string | undefined> {
    const cached = versionCache.get(provider);
    if (cached?.executable === executable) return cached.version;
    try {
        const environment = await runtimeProcessEnvironment();
        const { stdout, stderr } = await execFileAsync(executable, ['--version'], {
            env: environment,
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
