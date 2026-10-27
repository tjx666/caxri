import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { AgentProvider } from '@caxri/protocol';
import { AGENT_STATE_ENVIRONMENT_KEYS, agentProviderIds } from '@caxri/protocol';

import type { E2EAgentPolicy, E2ERealAgentSurface } from './agent-policy.js';
import {
    e2eAgentPolicyEnvironment,
    e2eAgentShellShims,
    e2eFakeExecutableEnvironmentKeys,
} from './agent-policy.js';

export type E2EAgentEnvironmentMode =
    | { mode: 'blocked' }
    | {
          mode: 'fake';
          environment?: NodeJS.ProcessEnv;
          executables: Partial<Record<AgentProvider, string>>;
      }
    | { mode: 'real'; provider: AgentProvider; surface?: E2ERealAgentSurface };

/**
 * Fixture directory each provider's isolated state lives under. Which environment overrides that directory must cover
 * is the shared `AGENT_STATE_ENVIRONMENT_KEYS` table, so an Electron test or Acceptance run isolates exactly the keys
 * the launchers forward and cannot miss one that would expose a developer's real local Agent state.
 */
const E2E_AGENT_STATE_DIRECTORY_NAMES: Record<AgentProvider, string> = {
    grok: 'grok',
    claude: 'claude',
    codex: 'codex',
};

export const e2eAgentStateEnvironmentKeys = agentProviderIds.flatMap(
    (provider) => AGENT_STATE_ENVIRONMENT_KEYS[provider],
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
        AGENT_STATE_ENVIRONMENT_KEYS[provider].flatMap((key) => {
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
            join(fixtureRoot, E2E_AGENT_STATE_DIRECTORY_NAMES[provider]),
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
                AGENT_STATE_ENVIRONMENT_KEYS[provider].map((key) => [
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
 * Fixed prompt for every isolated E2E and Acceptance shell. Without it, the system startup files (`/etc/zshrc`,
 * `/etc/bashrc`) render `%n@%m` / `\h \u`, so a screenshot or trace of a Terminal-focused failure names the runner's
 * account and host (issue #1461).
 */
export const E2E_SHELL_PROMPT = 'caxri-e2e$ ';

const BASH_FAMILY_PROMPT = `PS1=${shellQuote(E2E_SHELL_PROMPT)}\n`;

/**
 * Zsh reads `.zlogin` last for the login shells Caxri launches, after `/etc/zshrc` and any `.zshrc` a spec seeds, so
 * the fixed prompt wins without overwriting spec-owned startup files. `RPROMPT` would otherwise be free to show host
 * state.
 */
const ZSH_PROMPT = `PROMPT=${shellQuote(E2E_SHELL_PROMPT)}
PS1="$PROMPT"
unset RPROMPT RPS1
`;

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
                surface: options.mode.surface ?? 'pty',
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
    const bashFamilyProfile = `${profile}${BASH_FAMILY_PROMPT}`;
    await Promise.all([
        writeFile(join(isolatedHome, '.zprofile'), profile, { encoding: 'utf8', mode: 0o600 }),
        writeFile(join(isolatedHome, '.zlogin'), ZSH_PROMPT, { encoding: 'utf8', mode: 0o600 }),
        writeFile(join(isolatedHome, '.bash_profile'), bashFamilyProfile, {
            encoding: 'utf8',
            mode: 0o600,
        }),
        writeFile(join(isolatedHome, '.profile'), bashFamilyProfile, {
            encoding: 'utf8',
            mode: 0o600,
        }),
    ]);

    const policy: E2EAgentPolicy =
        options.mode.mode === 'fake'
            ? { mode: 'fake', executables: fakeExecutables }
            : { mode: 'blocked' };
    return {
        ...isolatedEnvironment,
        PATH: shellPath,
        /**
         * Caxri's zsh integration sources user startup files from `ZDOTDIR ?? HOME`; an inherited `ZDOTDIR` would
         * bypass the isolated HOME and load the host's real dotfiles.
         */
        ZDOTDIR: isolatedHome,
        ...e2eAgentPolicyEnvironment(policy),
    };
}

export function e2eAgentEnvironmentKeys(): readonly string[] {
    return [
        'CAXRI_E2E_AGENT_MODE',
        'CAXRI_E2E_AGENT_PROVIDER',
        'CAXRI_E2E_AGENT_SURFACE',
        ...e2eFakeExecutableEnvironmentKeys(),
        ...e2eAgentStateEnvironmentKeys,
    ];
}
