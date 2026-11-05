import { posix } from 'node:path';

import { isOpaqueAgentSessionId } from '../contract';
import type { AgentLifecyclePhase } from './contract';

const MAX_WORKTREE_CREATE_PATH_LENGTH = 1_024;

const SHELL_TOOL_PHASES = new Set<AgentLifecyclePhase>([
    'shellToolStarted',
    'shellToolFinished',
    'shellToolFailed',
]);

function isNormalizedAbsolutePath(path: unknown): boolean {
    if (typeof path !== 'string') return false;
    if (path === '/') return false;
    if (path.length > MAX_WORKTREE_CREATE_PATH_LENGTH) return false;
    if (!path.startsWith('/') || path.includes('\0')) return false;
    return path === posix.normalize(path);
}

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
    if (
        signal.worktreeCreatePath !== undefined &&
        (signal.worktreeCreateIntent !== true ||
            !isNormalizedAbsolutePath(signal.worktreeCreatePath))
    )
        return 'invalidSignal';
    if (isShell && (signal.worktreeCreateIntent === true) !== (signal.agentToolUseId !== undefined))
        return 'invalidSignal';
    if (phase === 'attentionResolved' && signal.agentToolUseId === undefined)
        return 'invalidAgentToolUseId';
    return undefined;
}
