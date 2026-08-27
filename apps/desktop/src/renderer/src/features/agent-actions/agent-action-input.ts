import type { AgentAction } from '@caxri/protocol';

export const agentActionSubmitModes = {
    primary: 'run',
    alternate: 'insert',
} as const;

export type AgentActionSubmitMode =
    (typeof agentActionSubmitModes)[keyof typeof agentActionSubmitModes];

/**
 * Agent input is append-only: alternate insertion leaves a trailing space for arguments, while primary execution
 * appends one Return. Neither path inspects, clears, or rewrites the provider's current draft.
 */
export function agentActionTerminalInput(action: AgentAction, mode: AgentActionSubmitMode): string {
    return mode === 'run' ? `${action.invocation}\r` : `${action.invocation} `;
}

export function canExecuteAgentAction(action: AgentAction): boolean {
    return !action.requiresArguments;
}
