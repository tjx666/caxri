import type { AgentProvider } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds } from '@caxri/protocol';

export const MAX_SHELL_COMMAND_LENGTH = 4_096;

export interface ShellInputState {
    command: string;
    isBracketedPaste: boolean;
    valid: boolean;
}

export interface ShellPromotionCandidate {
    /**
     * Provider session reported by the cross-provider hook signal that opened this switch candidate. A hook-opened
     * candidate starts too late for the `startedAt` metadata filter to see the already-running session, so this is the
     * only identity a confirmed switch can adopt immediately.
     */
    agentSessionId?: string;
    attempts: number;
    expiresAt: number;
    nextProcessProbeAt: number;
    /**
     * How the candidate was opened. Only an input-opened candidate (the user submitted a command at the prompt) may be
     * confirmed by provider metadata: hook signals are inherited by nested agent tool-calls, which also create real
     * provider sessions in the same cwd, so a hook-opened candidate must wait for the foreground-process probe.
     */
    origin: 'hook' | 'input';
    processProbes: number;
    provider?: AgentProvider;
    startedAt: number;
}

const providerByExecutableName = new Map<string, AgentProvider>(
    agentProviderIds.map((provider) => [agentProviderCatalog[provider].executableName, provider]),
);

export function directAgentProvider(command: string): AgentProvider | undefined {
    const normalized = command.trim();
    if (/[;&|<>]/.test(normalized)) return undefined;
    const executable = normalized.match(/^(\S+)/)?.[1];
    const basename = executable?.split(/[\\/]/).at(-1);
    return basename ? providerByExecutableName.get(basename) : undefined;
}

export function canInspectShellLaunch(command: string): boolean {
    const normalized = command.trim();
    return Boolean(normalized) && !/[;&|<>]/.test(normalized);
}
