import type { AgentAction, AgentProvider } from '@caxri/protocol';

export const agentActionSubmitModes = {
    primary: 'run',
    alternate: 'insert',
} as const;

export type AgentActionSubmitMode =
    (typeof agentActionSubmitModes)[keyof typeof agentActionSubmitModes];

export interface AgentActionTerminalInputStep {
    data: string;
    delayBeforeMs?: number;
}

interface AgentActionRunSuffixStep {
    delayBeforeMs?: number;
    suffix: string;
}

const CODEX_SKILL_PASTE_BURST_SETTLE_MS = 150;

/**
 * Codex classifies rapidly streamed characters as a paste and turns Enter into a newline for 120ms. Its skill flow
 * therefore needs one write for the invocation, a deliberate settle window, then Tab to accept the exact completion and
 * Return to submit it. Raw LF is Ctrl+J in Codex's terminal mode and only inserts a newline. See
 * https://github.com/openai/codex/blob/9a8730f3/codex-rs/tui/src/bottom_pane/paste_burst.rs and
 * https://github.com/openai-oss-forks/crossterm/blob/45fecb9508105988f42fe6ff0441783ed3717f92/src/event/sys/unix/parse.rs#L143-L160
 * and https://github.com/tjx666/caxri/issues/398.
 */
const agentActionRunSuffixSteps: Record<
    AgentProvider,
    Record<AgentAction['kind'], readonly AgentActionRunSuffixStep[]>
> = {
    grok: { command: [], skill: [] },
    antigravity: { command: [], skill: [] },
    claude: {
        command: [{ suffix: '\r' }],
        skill: [{ suffix: '\r' }],
    },
    codex: {
        command: [{ suffix: '\r' }],
        skill: [
            { suffix: '' },
            { delayBeforeMs: CODEX_SKILL_PASTE_BURST_SETTLE_MS, suffix: '\t\r' },
        ],
    },
};

/**
 * Agent input is append-only: alternate insertion leaves a trailing space for arguments, while primary execution uses
 * the provider's exact submission sequence. Neither path inspects, clears, or rewrites the provider's current draft.
 */
export function agentActionTerminalInputSteps(
    provider: AgentProvider,
    action: AgentAction,
    mode: AgentActionSubmitMode,
): readonly AgentActionTerminalInputStep[] {
    if (mode === 'insert') return [{ data: `${action.invocation} ` }];

    return agentActionRunSuffixSteps[provider][action.kind].map((step, index) => ({
        data: `${index === 0 ? action.invocation : ''}${step.suffix}`,
        ...(step.delayBeforeMs && { delayBeforeMs: step.delayBeforeMs }),
    }));
}

export function canExecuteAgentAction(action: AgentAction): boolean {
    return !action.requiresArguments;
}

/**
 * The chord that inserts the selected action into the Agent's draft instead of running it. Every other modifier must be
 * absent: `Cmd+Shift+Enter` and `Cmd+Alt+Enter` belong to whatever else claims them, and cmdk would otherwise read them
 * as a plain Enter and run the action the user meant to insert.
 */
export function isAlternateAgentActionChord(event: {
    altKey: boolean;
    ctrlKey: boolean;
    key: string;
    metaKey: boolean;
    shiftKey: boolean;
}): boolean {
    return (
        event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey && event.key === 'Enter'
    );
}
