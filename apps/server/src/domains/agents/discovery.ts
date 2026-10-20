import type { AgentProvider } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds } from '@caxri/protocol';
import { readE2EAgentPolicy, selectE2EAgentExecutable, SingleFlight } from '@caxri/system';

import {
    clearServerExecutableCache,
    resolveServerExecutable,
    runExternalCommand,
} from '../executables';

const executableNames: Record<AgentProvider, string> = Object.fromEntries(
    agentProviderIds.map((provider) => [provider, agentProviderCatalog[provider].executableName]),
) as Record<AgentProvider, string>;

const executableRequests = new SingleFlight<string, string | undefined>();
const versionCache = new Map<AgentProvider, { executable: string; version: string }>();

export function clearExecutableCache(): void {
    clearServerExecutableCache();
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
    return executableRequests.run(requestKey, () => resolveServerExecutable(selectedExecutable));
}

export async function readVersion(
    provider: AgentProvider,
    executable: string,
): Promise<string | undefined> {
    const cached = versionCache.get(provider);
    if (cached?.executable === executable) return cached.version;
    try {
        const { stdout, stderr } = await runExternalCommand(executable, ['--version'], {
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
