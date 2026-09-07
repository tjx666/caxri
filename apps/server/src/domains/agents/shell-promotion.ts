import type { AgentProvider, TerminalRecord } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds } from '@caxri/protocol';

export const MAX_SHELL_COMMAND_LENGTH = 4_096;
export const SHELL_PROMOTION_WINDOW_MS = 30_000;

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

function directAgentProvider(command: string): AgentProvider | undefined {
    const normalized = command.trim();
    if (/[;&|<>]/.test(normalized)) return undefined;
    const executable = normalized.match(/^(\S+)/)?.[1];
    const basename = executable?.split(/[\\/]/).at(-1);
    return basename ? providerByExecutableName.get(basename) : undefined;
}

function canInspectShellLaunch(command: string): boolean {
    const normalized = command.trim();
    return Boolean(normalized) && !/[;&|<>]/.test(normalized);
}

function inputPromotionCandidate(
    provider: AgentProvider | undefined,
    startedAt: number,
): ShellPromotionCandidate {
    return {
        attempts: 0,
        expiresAt: startedAt + SHELL_PROMOTION_WINDOW_MS,
        nextProcessProbeAt: 0,
        origin: 'input',
        processProbes: 0,
        provider,
        startedAt,
    };
}

/**
 * Decides what a submitted shell command does to the Terminal's promotion candidate: `ignore` leaves the current
 * candidate alone, `clear` drops it, and a candidate object replaces it.
 */
export function decideInputPromotionCandidate(
    terminal: Pick<TerminalRecord, 'lastAgentProcessState' | 'provider'>,
    command: string,
    startedAt: number,
): ShellPromotionCandidate | 'clear' | 'ignore' {
    if (!canInspectShellLaunch(command)) return 'clear';
    const provider = directAgentProvider(command);
    /**
     * After the bound agent exits, the user can relaunch a different agent through an alias or a history recall, so any
     * inspectable command opens a candidate. The foreground-process probe (or, for a direct different-provider command,
     * its metadata fallback) must still confirm before identity or availability changes. A direct same-provider command
     * is ignored while the bound Agent is already live.
     */
    if (
        terminal.provider &&
        provider === terminal.provider &&
        (terminal.lastAgentProcessState === 'starting' ||
            terminal.lastAgentProcessState === 'running')
    )
        return 'ignore';
    return inputPromotionCandidate(provider, startedAt);
}
