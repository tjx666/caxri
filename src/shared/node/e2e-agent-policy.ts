import { isAbsolute } from 'node:path';

import {
    agentProviderCatalog,
    agentProviderIds,
    type AgentLaunchSettings,
    type AgentProvider,
} from '../agents';
import { CaxriError } from '../ipc/errors';

export type E2EAgentPolicy =
    | { mode: 'blocked' }
    | { mode: 'fake'; executables: Partial<Record<AgentProvider, string>> }
    | { mode: 'real'; provider: AgentProvider };

export interface E2EAgentPolicyInput {
    isE2E: boolean;
    requestedMode?: string;
    requestedProvider?: string;
    requestedExecutables?: Partial<Record<AgentProvider, string | undefined>>;
}

function isAgentProvider(value: string | undefined): value is AgentProvider {
    return agentProviderIds.some((provider) => provider === value);
}

/**
 * Converts process-boundary strings into one fail-closed E2E Agent policy. Production has no
 * policy; E2E defaults to blocked, fake executables must be absolute, and real mode selects only
 * one provider so a missing CLI can never silently fall back to another account.
 */
export function resolveE2EAgentPolicy(input: E2EAgentPolicyInput): E2EAgentPolicy | undefined {
    if (!input.isE2E) return undefined;
    const mode = input.requestedMode || 'blocked';
    if (mode === 'blocked') return { mode };
    if (mode === 'real') {
        const provider = input.requestedProvider || 'codex';
        if (!isAgentProvider(provider))
            throw new Error(`Unsupported E2E Agent provider: ${provider}`);
        return { mode, provider };
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

/** Returns the only executable request allowed by the E2E policy. */
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

const REAL_CODEX_ARGUMENT_PREFIX = [
    'exec',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-rules',
    '--color',
    'never',
] as const;

/**
 * Real E2E authority is deliberately narrower than normal provider settings: one ephemeral Codex
 * execution, a read-only sandbox, and one short natural-language prompt supplied as structured
 * argv. Fake mode owns every interactive or control-byte scenario.
 */
export function assertE2EAgentLaunch(
    policy: E2EAgentPolicy | undefined,
    provider: AgentProvider,
    launch: AgentLaunchSettings,
): void {
    if (policy?.mode !== 'real') return;
    if (provider !== policy.provider)
        throw new CaxriError('UNAVAILABLE', `${provider} is not enabled for this real Agent E2E`);
    const prompt = launch.args.at(-1);
    const prefix = launch.args.slice(0, -1);
    if (
        provider !== 'codex' ||
        launch.executable !== agentProviderCatalog.codex.executableName ||
        prefix.length !== REAL_CODEX_ARGUMENT_PREFIX.length ||
        !prefix.every((argument, index) => argument === REAL_CODEX_ARGUMENT_PREFIX[index]) ||
        !prompt ||
        prompt !== prompt.trim() ||
        prompt.length > 200 ||
        /\p{Cc}/u.test(prompt)
    ) {
        throw new CaxriError(
            'VALIDATION',
            'Real Agent E2E requires the bounded read-only Codex smoke launch',
        );
    }
}

/** Real Agent E2E accepts its one natural prompt only through validated launch argv. */
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

/** Real mode has no general-purpose Shell escape hatch; its one Codex process is managed directly. */
export function assertE2EShellLaunch(policy: E2EAgentPolicy | undefined): void {
    if (policy?.mode === 'real')
        throw new CaxriError('VALIDATION', 'Real Agent E2E does not allow Shell Terminal launches');
}

/** Produces the narrow environment contract forwarded from Electron Main to the Runtime. */
export function e2eAgentPolicyEnvironment(policy: E2EAgentPolicy | undefined): NodeJS.ProcessEnv {
    if (!policy) return {};
    return {
        CAXRI_E2E: '1',
        CAXRI_E2E_AGENT_MODE: policy.mode,
        ...(policy.mode === 'real' ? { CAXRI_E2E_AGENT_PROVIDER: policy.provider } : {}),
        ...(policy.mode === 'fake'
            ? {
                  ...(policy.executables.claude
                      ? { CAXRI_E2E_FAKE_CLAUDE_EXECUTABLE: policy.executables.claude }
                      : {}),
                  ...(policy.executables.codex
                      ? { CAXRI_E2E_FAKE_CODEX_EXECUTABLE: policy.executables.codex }
                      : {}),
              }
            : {}),
    };
}

/** Reads only the Main-approved Runtime variables; arbitrary parent environment is ignored. */
export function readE2EAgentPolicy(
    environment: NodeJS.ProcessEnv = process.env,
): E2EAgentPolicy | undefined {
    return resolveE2EAgentPolicy({
        isE2E: environment.CAXRI_E2E === '1',
        requestedMode: environment.CAXRI_E2E_AGENT_MODE,
        requestedProvider: environment.CAXRI_E2E_AGENT_PROVIDER,
        requestedExecutables: {
            claude: environment.CAXRI_E2E_FAKE_CLAUDE_EXECUTABLE,
            codex: environment.CAXRI_E2E_FAKE_CODEX_EXECUTABLE,
        },
    });
}
