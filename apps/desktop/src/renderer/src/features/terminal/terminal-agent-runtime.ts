import type { ProcessState } from '@caxri/protocol';

/**
 * A Terminal keeps its Agent association after the Agent child exits. Only the live child state enables Agent-specific
 * input; the surrounding shell otherwise keeps its normal keyboard and clipboard behavior.
 */
export function isAgentProcessRunning(lastAgentProcessState: ProcessState | undefined): boolean {
    return lastAgentProcessState === 'running';
}
