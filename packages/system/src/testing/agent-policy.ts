import { isAbsolute } from 'node:path';
import process from 'node:process';

import type { AgentLaunchSettings, AgentProvider } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds, CaxriError } from '@caxri/protocol';

export type E2EAgentPolicy =
    | { mode: 'blocked' }
    | { mode: 'fake'; executables: Partial<Record<AgentProvider, string>> }
    | { mode: 'real'; provider: AgentProvider; surface: E2ERealAgentSurface };

/**
 * The one surface a real-Agent E2E run may launch: the bounded `codex exec` PTY smoke, or one read-only Agent Chat. A
 * run never holds both, so a Chat smoke cannot also open a Terminal and the PTY smoke cannot start a Chat.
 */
export type E2ERealAgentSurface = 'chat' | 'pty';

export interface E2EAgentPolicyInput {
    isE2E: boolean;
    requestedMode?: string;
    requestedProvider?: string;
    requestedSurface?: string;
    requestedExecutables?: Partial<Record<AgentProvider, string | undefined>>;
}

type E2EFakeExecutables = Partial<Record<string, string | undefined>>;

/**
 * Encodes one provider-specific fake executable into the narrow Main-to-Runtime environment contract. Provider ids
 * remain the source of truth, so a new catalog entry cannot be silently omitted from the E2E process boundary or
 * isolated Shell PATH.
 */
export function e2eFakeExecutableEnvironmentKey(provider: string): string {
    return `CAXRI_E2E_FAKE_${provider.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}_EXECUTABLE`;
}

/**
 * Lists every provider-specific fake executable key accepted at the process boundary.
 */
export function e2eFakeExecutableEnvironmentKeys(
    providers: readonly string[] = agentProviderIds,
): string[] {
    const entries = providers.map((provider) => ({
        provider,
        key: e2eFakeExecutableEnvironmentKey(provider),
    }));
    const providersByKey = new Map<string, string>();
    for (const entry of entries) {
        const existingProvider = providersByKey.get(entry.key);
        if (existingProvider && existingProvider !== entry.provider) {
            throw new Error(
                `E2E fake executable environment keys collide for ${existingProvider} and ${entry.provider}: ${entry.key}`,
            );
        }
        providersByKey.set(entry.key, entry.provider);
    }
    return entries.map((entry) => entry.key);
}

/**
 * Serializes fake executable authority for exactly the supplied provider ids.
 */
export function e2eFakeExecutableEnvironment(
    executables: E2EFakeExecutables,
    providers: readonly string[] = agentProviderIds,
): NodeJS.ProcessEnv {
    const environmentKeys = e2eFakeExecutableEnvironmentKeys(providers);
    return Object.fromEntries(
        providers.flatMap((provider, index) => {
            const executable = executables[provider];
            return executable ? [[environmentKeys[index], executable]] : [];
        }),
    );
}

/**
 * Reads fake executable authority only from the generated provider-specific environment keys.
 */
export function readE2EFakeExecutables(
    environment: NodeJS.ProcessEnv,
    providers: readonly string[] = agentProviderIds,
): E2EFakeExecutables {
    const environmentKeys = e2eFakeExecutableEnvironmentKeys(providers);
    return Object.fromEntries(
        providers.flatMap((provider, index) => {
            const executable = environment[environmentKeys[index]];
            return executable ? [[provider, executable]] : [];
        }),
    );
}

export interface E2EAgentShellShim {
    provider: string;
    executable: string;
    source: string;
}

export interface E2EAgentShellShimProvider {
    executableName: string;
    provider: string;
}

/**
 * Returns one Shell shim descriptor per catalog entry, including a provider's CLI executable name.
 */
export function e2eAgentShellShimProviders(): E2EAgentShellShimProvider[] {
    return agentProviderIds.map((provider) => ({
        provider,
        executableName: agentProviderCatalog[provider].executableName,
    }));
}

/**
 * Produces a Caxri-owned executable for every managed provider in an isolated Shell PATH. A fake target preserves
 * explicit test authority; otherwise the shim blocks ambient host CLIs.
 */
export function e2eAgentShellShims(
    executables: E2EFakeExecutables,
    providers: readonly E2EAgentShellShimProvider[] = e2eAgentShellShimProviders(),
): E2EAgentShellShim[] {
    assertE2EAgentShellShimProviders(providers);
    return providers.map((provider) => {
        const target = executables[provider.provider];
        return {
            provider: provider.provider,
            executable: provider.executableName,
            source: target
                ? `#!/bin/sh\nexec ${shellQuote(target)} "$@"\n`
                : `#!/bin/sh\nprintf 'Caxri E2E blocked ${provider.executableName}\\n' >&2\nexit 127\n`,
        };
    });
}

const portableShellExecutableName = /^[A-Z0-9][\w-]*$/i;

/**
 * Rejects names that could escape the generated PATH directory or shadow each other.
 */
function assertE2EAgentShellShimProviders(providers: readonly E2EAgentShellShimProvider[]): void {
    const providersByExecutable = new Map<string, string>();
    for (const provider of providers) {
        if (!portableShellExecutableName.test(provider.executableName)) {
            throw new Error(
                `E2E Agent Shell shim executable must be a portable basename: ${provider.executableName}`,
            );
        }
        const existingProvider = providersByExecutable.get(provider.executableName);
        if (existingProvider) {
            throw new Error(
                `E2E Agent Shell shim executable must be unique: ${provider.executableName} (${existingProvider}, ${provider.provider})`,
            );
        }
        providersByExecutable.set(provider.executableName, provider.provider);
    }
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isAgentProvider(value: string | undefined): value is AgentProvider {
    // `Array#includes` narrows its argument to the tuple's element type, but this is a runtime
    // type guard over a `string | undefined` input; widen the array's type for the call instead
    // of narrowing `value`.
    return (agentProviderIds as ReadonlyArray<string | undefined>).includes(value);
}

/**
 * Converts process-boundary strings into one fail-closed E2E Agent policy. Production has no policy; E2E defaults to
 * blocked, fake executables must be absolute, and real mode selects only one provider so a missing CLI can never
 * silently fall back to another account.
 */
export function resolveE2EAgentPolicy(input: E2EAgentPolicyInput): E2EAgentPolicy | undefined {
    if (!input.isE2E) return undefined;
    // `||` (not `??`) is deliberate: an env-sourced mode/provider explicitly set to `''` must also
    // fail closed to the default rather than flowing through as an empty string.
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty string must also fall back to the fail-closed default
    const mode = input.requestedMode || 'blocked';
    if (mode === 'blocked') return { mode };
    if (mode === 'real') {
        // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty string must also fall back to the fail-closed default
        const provider = input.requestedProvider || 'codex';
        if (!isAgentProvider(provider))
            throw new Error(`Unsupported E2E Agent provider: ${provider}`);
        // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty string must also fall back to the fail-closed default
        const surface = input.requestedSurface || 'pty';
        if (surface !== 'pty' && surface !== 'chat')
            throw new Error(`Unsupported real E2E Agent surface: ${surface}`);
        return { mode, provider, surface };
    }
    if (mode === 'fake') {
        const executables = Object.fromEntries(
            agentProviderIds.flatMap((provider) => {
                const executable = input.requestedExecutables?.[provider];
                if (!executable) return [];
                if (!isAbsolute(executable))
                    throw new Error(`Fake ${provider} executable must be an absolute path`);
                return [[provider, executable]];
            }),
        ) as Partial<Record<AgentProvider, string>>;
        if (Object.keys(executables).length === 0)
            throw new Error('Fake E2E Agent mode requires at least one executable');
        return { mode, executables };
    }
    throw new Error(`Unsupported E2E Agent mode: ${mode}`);
}

/**
 * Returns the only executable request allowed by the E2E policy.
 */
export function selectE2EAgentExecutable(
    policy: E2EAgentPolicy | undefined,
    provider: AgentProvider,
    requestedExecutable: string,
): string | undefined {
    if (!policy) return requestedExecutable;
    if (policy.mode === 'blocked') return undefined;
    if (policy.mode === 'fake') return policy.executables[provider];
    return policy.provider === provider ? requestedExecutable : undefined;
}

interface RealE2EAgentLaunchPolicy {
    argumentPrefix: readonly string[];
    executableName: string;
}

/**
 * Real-host execution is an explicit safety decision per provider. `null` means fake mode remains the only authorized
 * test surface; a catalog extension cannot inherit Codex's reviewed arguments by omission.
 */
const REAL_E2E_AGENT_LAUNCH_POLICIES: Record<AgentProvider, RealE2EAgentLaunchPolicy | null> = {
    grok: null,
    claude: null,
    codex: {
        argumentPrefix: [
            'exec',
            '--sandbox',
            'read-only',
            '--skip-git-repo-check',
            '--ephemeral',
            '--ignore-rules',
            '--color',
            'never',
        ],
        executableName: agentProviderCatalog.codex.executableName,
    },
};

/**
 * Real E2E authority is deliberately narrower than normal provider settings: one ephemeral Codex execution, a read-only
 * sandbox, and one short natural-language prompt supplied as structured argv. Fake mode owns every interactive or
 * control-byte scenario.
 */
export function assertE2EAgentLaunch(
    policy: E2EAgentPolicy | undefined,
    provider: AgentProvider,
    launch: AgentLaunchSettings,
    resumeAgentSessionId?: string,
): void {
    if (policy?.mode !== 'real') return;
    if (provider !== policy.provider)
        throw new CaxriError('UNAVAILABLE', `${provider} is not enabled for this real Agent E2E`);
    if (policy.surface !== 'pty')
        throw new CaxriError('VALIDATION', 'Real Agent Chat E2E does not launch Agent Terminals');
    if (resumeAgentSessionId)
        throw new CaxriError(
            'VALIDATION',
            'Real Agent E2E does not resume persisted Agent sessions',
        );
    const prompt = launch.args.at(-1);
    const prefix = launch.args.slice(0, -1);
    const launchPolicy = REAL_E2E_AGENT_LAUNCH_POLICIES[provider];
    // Simple identifier-based conditions are ordered first per unicorn/prefer-simple-condition-first;
    // every branch below is a pure boolean check with no side effects, so reordering is safe.
    if (
        !launchPolicy ||
        !prompt ||
        launch.executable !== launchPolicy.executableName ||
        prompt !== prompt.trim() ||
        prompt.length > 200 ||
        prefix.length !== launchPolicy.argumentPrefix.length ||
        prefix.some((argument, index) => argument !== launchPolicy.argumentPrefix[index]) ||
        /\p{Cc}/u.test(prompt)
    ) {
        throw new CaxriError(
            'VALIDATION',
            'Real Agent E2E requires the bounded read-only Codex smoke launch',
        );
    }
}

/**
 * Providers whose Chat a real-Agent E2E may start. `false` keeps fake mode as the only authorized Chat test surface; a
 * provider gaining Chat support does not inherit real-host authority by omission.
 */
const REAL_E2E_AGENT_CHAT_PROVIDERS: Record<AgentProvider, boolean> = {
    grok: false,
    claude: false,
    codex: true,
};

/**
 * Real Chat authority covers one provider process with the catalog executable. The caller pins the thread to a
 * read-only sandbox without approvals, so an unattended run can neither write nor block on a request.
 */
export function assertE2EAgentChatLaunch(
    policy: E2EAgentPolicy | undefined,
    provider: AgentProvider,
    launch: AgentLaunchSettings,
): void {
    if (policy?.mode !== 'real') return;
    if (
        policy.surface !== 'chat' ||
        provider !== policy.provider ||
        !REAL_E2E_AGENT_CHAT_PROVIDERS[provider] ||
        launch.executable !== agentProviderCatalog[provider].executableName
    )
        throw new CaxriError('UNAVAILABLE', 'Chat is unavailable in this real-Agent E2E');
}

/**
 * A real Chat smoke sends only short natural prompts, matching the PTY smoke's bound on its one argv prompt.
 */
export function assertE2EAgentChatInput(policy: E2EAgentPolicy | undefined, text: string): void {
    if (policy?.mode !== 'real') return;
    if (!text || text !== text.trim() || text.length > 200 || /\p{Cc}/u.test(text))
        throw new CaxriError(
            'VALIDATION',
            'Real Agent Chat E2E accepts only short natural prompts',
        );
}

/**
 * Real Agent E2E accepts its one natural prompt only through validated launch argv.
 */
export function assertE2EAgentInput(
    policy: E2EAgentPolicy | undefined,
    provider: AgentProvider,
): void {
    if (policy?.mode === 'real' && provider === policy.provider)
        throw new CaxriError(
            'VALIDATION',
            'Real Agent E2E does not accept interactive Terminal input',
        );
}

/**
 * Applies the environment-owned policy at a public Terminal input boundary before asynchronous execution begins.
 */
export function assertE2EAgentInputFromEnvironment(
    provider: AgentProvider | undefined,
    environment: NodeJS.ProcessEnv = process.env,
): void {
    if (provider) assertE2EAgentInput(readE2EAgentPolicy(environment), provider);
}

/**
 * Real mode has no general-purpose Shell escape hatch; its one Codex process is managed directly.
 */
export function assertE2EShellLaunch(policy: E2EAgentPolicy | undefined): void {
    if (policy?.mode === 'real')
        throw new CaxriError('VALIDATION', 'Real Agent E2E does not allow Shell Terminal launches');
}

/**
 * Produces the narrow environment contract forwarded from Electron Main to the Runtime.
 */
export function e2eAgentPolicyEnvironment(policy: E2EAgentPolicy | undefined): NodeJS.ProcessEnv {
    if (!policy) return {};
    return {
        CAXRI_E2E: '1',
        CAXRI_E2E_AGENT_MODE: policy.mode,
        ...(policy.mode === 'real' && {
            CAXRI_E2E_AGENT_PROVIDER: policy.provider,
            CAXRI_E2E_AGENT_SURFACE: policy.surface,
        }),
        ...(policy.mode === 'fake' && e2eFakeExecutableEnvironment(policy.executables)),
    };
}

/**
 * Reads only the Main-approved Runtime variables; arbitrary parent environment is ignored.
 */
export function readE2EAgentPolicy(
    environment: NodeJS.ProcessEnv = process.env,
): E2EAgentPolicy | undefined {
    return resolveE2EAgentPolicy({
        isE2E: environment.CAXRI_E2E === '1',
        requestedMode: environment.CAXRI_E2E_AGENT_MODE,
        requestedProvider: environment.CAXRI_E2E_AGENT_PROVIDER,
        requestedSurface: environment.CAXRI_E2E_AGENT_SURFACE,
        requestedExecutables: readE2EFakeExecutables(environment),
    });
}
