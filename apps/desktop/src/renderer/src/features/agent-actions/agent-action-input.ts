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
 * LF to submit it. Commands and Claude Code actions execute with Return in one write. See
 * https://github.com/openai/codex/blob/9a8730f3/codex-rs/tui/src/bottom_pane/paste_burst.rs and
 * https://github.com/tjx666/caxri/issues/398.
 */
const agentActionRunSuffixSteps: Record<
    AgentProvider,
    Record<AgentAction['kind'], readonly AgentActionRunSuffixStep[]>
> = {
    claude: {
        command: [{ suffix: '\r' }],
        skill: [{ suffix: '\r' }],
    },
    codex: {
        command: [{ suffix: '\r' }],
        skill: [
            { suffix: '' },
            { delayBeforeMs: CODEX_SKILL_PASTE_BURST_SETTLE_MS, suffix: '\t\n' },
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
