import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { AgentProvider } from '@caxri/protocol';
import { agentProviderIds } from '@caxri/protocol';

import type { E2EAgentPolicy } from './agent-policy';
import {
    e2eAgentPolicyEnvironment,
    e2eAgentShellShims,
    e2eFakeExecutableEnvironmentKeys,
} from './agent-policy';

interface E2EAgentStatePolicy {
    directoryName: string;
    environmentKeys: readonly string[];
}

export type E2EAgentEnvironmentMode =
    | { mode: 'blocked' }
    | {
          mode: 'fake';
          environment?: NodeJS.ProcessEnv;
          executables: Partial<Record<AgentProvider, string>>;
      }
    | { mode: 'real'; provider: AgentProvider };

/**
 * Provider-owned state paths are an explicit isolation decision. A new provider must name every environment override
 * that could otherwise expose a developer's real local Agent state to an Electron test or Acceptance run.
 */
const E2E_AGENT_STATE_POLICIES: Record<AgentProvider, E2EAgentStatePolicy> = {
    grok: { directoryName: 'grok', environmentKeys: ['GROK_HOME'] },
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

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Builds the complete fail-closed Agent environment shared by Electron E2E and Acceptance. Fake authority is explicit,
 * uses absolute executables, and keeps every provider state directory beneath the caller-owned fixture root.
 */
export async function createE2EAgentEnvironment(options: {
    fixtureRoot: string;
    mode: E2EAgentEnvironmentMode;
    sourceEnvironment: NodeJS.ProcessEnv;
}): Promise<NodeJS.ProcessEnv> {
    if (options.mode.mode === 'real') {
        return {
            ...selectE2ERealAgentStateEnvironment(options.mode.provider, options.sourceEnvironment),
            ...e2eAgentPolicyEnvironment({
                mode: 'real',
                provider: options.mode.provider,
            }),
        };
    }

    const isolatedEnvironment = await createE2EAgentIsolationEnvironment(options.fixtureRoot);
    const fakeExecutables = options.mode.mode === 'fake' ? options.mode.executables : {};
    if (options.mode.mode === 'fake') {
        for (const executable of Object.values(fakeExecutables)) {
            if (executable && !isAbsolute(executable))
                throw new Error('Fake Agent executables must use absolute paths');
        }
        Object.assign(isolatedEnvironment, options.mode.environment);
    }

    const shellBin = join(options.fixtureRoot, 'shell-bin');
    await mkdir(shellBin, { recursive: true });
    await Promise.all(
        e2eAgentShellShims(fakeExecutables).map(async (shim) => {
            const executable = join(shellBin, shim.executable);
            await writeFile(executable, shim.source, 'utf8');
            await chmod(executable, 0o700);
        }),
    );
    const shellPath = `${shellBin}:${options.sourceEnvironment.PATH ?? '/usr/bin:/bin'}`;
    const profile = `export PATH=${shellQuote(shellPath)}\n`;
    const isolatedHome = isolatedEnvironment.HOME;
    if (!isolatedHome || !isAbsolute(isolatedHome))
        throw new Error('Isolated E2E Agent HOME must be an absolute path');
    await Promise.all([
        writeFile(join(isolatedHome, '.zprofile'), profile, { encoding: 'utf8', mode: 0o600 }),
        writeFile(join(isolatedHome, '.bash_profile'), profile, { encoding: 'utf8', mode: 0o600 }),
        writeFile(join(isolatedHome, '.profile'), profile, { encoding: 'utf8', mode: 0o600 }),
    ]);

    const policy: E2EAgentPolicy =
        options.mode.mode === 'fake'
            ? { mode: 'fake', executables: fakeExecutables }
            : { mode: 'blocked' };
    return {
        ...isolatedEnvironment,
        PATH: shellPath,
        ...e2eAgentPolicyEnvironment(policy),
    };
}

export function e2eAgentEnvironmentKeys(): readonly string[] {
    return [
        'CAXRI_E2E_AGENT_MODE',
        'CAXRI_E2E_AGENT_PROVIDER',
        ...e2eFakeExecutableEnvironmentKeys(),
        ...e2eAgentStateEnvironmentKeys,
    ];
}
