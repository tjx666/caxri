import type { AgentProvider, TerminalRecord } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds } from '@caxri/protocol';

import type { AgentLifecycleSignal } from './hooks/contract';

const MAX_SHELL_COMMAND_LENGTH = 4_096;
export const SHELL_PROMOTION_WINDOW_MS = 30_000;
const BRACKETED_PASTE_START = '\u{1B}[200~';
const BRACKETED_PASTE_END = '\u{1B}[201~';

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
    /**
     * Retains the latest turn boundary while independent foreground confirmation is pending. A startup hook alone
     * cannot promote a Shell, but losing that boundary would leave a promptly submitted first turn permanently idle.
     */
    lifecycleSignal?: AgentLifecycleSignal;
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
 * Advances the Terminal's unpublished-input state machine over one PTY input chunk, without logging or persisting the
 * text. `onSubmit` fires only for a complete unedited command; `onDiscard` fires when the user drops the line with
 * Ctrl-C or Ctrl-U. Both run in the exact order their characters arrive, so a submission followed by a discard inside
 * one chunk still retires the candidate it just opened. It lives beside the promotion rules rather than inside
 * `AgentCoordinator` so that module stays within the repository's file-size budget.
 */
export function scanShellInput(
    initial: ShellInputState,
    data: string,
    handlers: { onDiscard: () => void; onSubmit: (command: string) => void },
): { didSubmit: boolean; state: ShellInputState } {
    let state = initial;
    let didSubmit = false;
    for (let index = 0; index < data.length; index += 1) {
        if (data.startsWith(BRACKETED_PASTE_START, index)) {
            state.isBracketedPaste = true;
            index += BRACKETED_PASTE_START.length - 1;
            continue;
        }
        if (data.startsWith(BRACKETED_PASTE_END, index)) {
            state.isBracketedPaste = false;
            index += BRACKETED_PASTE_END.length - 1;
            continue;
        }
        const character = data[index];
        if (character === '\r' || character === '\n') {
            if (state.isBracketedPaste) {
                state.command += '\n';
                state.valid = false;
                continue;
            }
            const hasContent = Boolean(state.command.trim());
            didSubmit ||= hasContent;
            if (hasContent && state.valid) handlers.onSubmit(state.command);
            state = { command: '', isBracketedPaste: false, valid: true };
            continue;
        }
        if (character === '\u{3}' || character === '\u{15}') {
            state = { command: '', isBracketedPaste: false, valid: true };
            handlers.onDiscard();
            continue;
        }
        if (character === '\b' || character === '\u{7F}') {
            if (state.valid) state.command = [...state.command].slice(0, -1).join('');
            continue;
        }
        if (character === '\u{1B}' || character === '\t') {
            state.valid = false;
            continue;
        }
        if (character < ' ') continue;
        if (!state.valid) continue;
        state.command += character;
        if (state.command.length > MAX_SHELL_COMMAND_LENGTH) state.valid = false;
    }
    return { didSubmit, state };
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
