import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { agentProviderCatalog, agentProviderIds, type AgentProvider } from '../../shared/agents';
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
    const requestKey = `${name}:${requestedExecutable}`;
    const pending = executableRequests.get(requestKey);
    if (pending) return pending;
    const request = resolveRuntimeExecutable(requestedExecutable).finally(() =>
        executableRequests.delete(requestKey),
    );
    executableRequests.set(requestKey, request);
    return request;
}

export async function readVersion(
    provider: AgentProvider,
    executable: string,
): Promise<string | undefined> {
    const cached = versionCache.get(provider);
    if (cached?.executable === executable) return cached.version;
    try {
        const env = await runtimeProcessEnvironment();
        const { stdout, stderr } = await execFileAsync(executable, ['--version'], {
            env,
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
