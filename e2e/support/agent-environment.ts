import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { AgentProvider } from '../../src/shared/agents.ts';
import { agentProviderIds } from '../../src/shared/agents.ts';

interface E2EAgentStatePolicy {
    directoryName: string;
    environmentKeys: readonly string[];
}

/**
 * Provider-owned state paths are an explicit isolation decision. A new provider must name every environment override
 * that could otherwise expose a developer's real local Agent state to an Electron test.
 */
const E2E_AGENT_STATE_POLICIES: Record<AgentProvider, E2EAgentStatePolicy> = {
    claude: { directoryName: 'claude', environmentKeys: ['CLAUDE_CONFIG_DIR'] },
    codex: {
        directoryName: 'codex',
        environmentKeys: ['CODEX_HOME', 'CODEX_SQLITE_HOME'],
    },
};

export const e2eAgentStateEnvironmentKeys = agentProviderIds.flatMap(
    (provider) => E2E_AGENT_STATE_POLICIES[provider].environmentKeys,
);

/**
 * Keeps only explicit state overrides for the selected real provider. The caller supplies this source separately from
 * `process.env`, so blocked ambient provider state cannot become real-agent test authority by accident.
 */
export function selectE2ERealAgentStateEnvironment(
    provider: AgentProvider,
    source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
    return Object.fromEntries(
        E2E_AGENT_STATE_POLICIES[provider].environmentKeys.flatMap((key) => {
            const value = source[key];
            if (value === undefined) return [];
            if (!isAbsolute(value))
                throw new Error(`Real E2E Agent state override ${key} must use an absolute path`);
            return [[key, value]];
        }),
    );
}

export async function createE2EAgentIsolationEnvironment(
    fixtureRoot: string,
): Promise<NodeJS.ProcessEnv> {
    const home = join(fixtureRoot, 'home');
    const xdg = join(fixtureRoot, 'xdg');
    const providerDirectories = Object.fromEntries(
        agentProviderIds.map((provider) => [
            provider,
            join(fixtureRoot, E2E_AGENT_STATE_POLICIES[provider].directoryName),
        ]),
    ) as Record<AgentProvider, string>;
    await Promise.all([
        mkdir(home, { recursive: true }),
        mkdir(xdg, { recursive: true }),
        ...agentProviderIds.map((provider) =>
            mkdir(providerDirectories[provider], { recursive: true }),
        ),
    ]);

    return {
        HOME: home,
        ...Object.fromEntries(
            agentProviderIds.flatMap((provider) =>
                E2E_AGENT_STATE_POLICIES[provider].environmentKeys.map((key) => [
                    key,
                    providerDirectories[provider],
                ]),
            ),
        ),
        XDG_CACHE_HOME: join(xdg, 'cache'),
        XDG_CONFIG_HOME: join(xdg, 'config'),
        XDG_DATA_HOME: join(xdg, 'data'),
    };
}
