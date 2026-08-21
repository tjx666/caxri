import type { AgentAction } from '@shared/types';

/**
 * Agent input is append-only: insertion leaves a trailing space for arguments, while explicit execution appends one
 * Return. Neither path inspects, clears, or rewrites the provider's current draft.
 */
export function agentActionTerminalInput(action: AgentAction, shouldExecute: boolean): string {
    return shouldExecute ? `${action.invocation}\r` : `${action.invocation} `;
}

export function canExecuteAgentAction(action: AgentAction): boolean {
    return !action.requiresArguments;
}
