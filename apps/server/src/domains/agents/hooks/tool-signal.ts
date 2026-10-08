import { isOpaqueAgentSessionId } from '../contract';
import type { AgentLifecyclePhase } from './contract';

const SHELL_TOOL_PHASES = new Set<AgentLifecyclePhase>([
    'shellToolStarted',
    'shellToolFinished',
    'shellToolFailed',
]);

/**
 * Validates opaque tool pairing without allowing question hooks to claim filesystem creation intent.
 */
export function validateToolSignal(
    signal: Record<string, unknown>,
    phase: AgentLifecyclePhase,
): 'invalidAgentToolUseId' | 'invalidSignal' | undefined {
    const isShell = SHELL_TOOL_PHASES.has(phase);
    if (
        signal.agentToolUseId !== undefined &&
        (typeof signal.agentToolUseId !== 'string' ||
            signal.agentToolUseId.length > 256 ||
            !isOpaqueAgentSessionId(signal.agentToolUseId) ||
            (!isShell && phase !== 'attentionRequested' && phase !== 'attentionResolved'))
    )
        return 'invalidAgentToolUseId';
    if (
        signal.worktreeCreateIntent !== undefined &&
        (!isShell || signal.worktreeCreateIntent !== true)
    )
        return 'invalidSignal';
    if (isShell && (signal.worktreeCreateIntent === true) !== (signal.agentToolUseId !== undefined))
        return 'invalidSignal';
    if (phase === 'attentionResolved' && signal.agentToolUseId === undefined)
        return 'invalidAgentToolUseId';
    return undefined;
}
