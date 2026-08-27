import type { ProcessState } from '@caxri/protocol';

/**
 * A PTY mounted before launch needs one final-grid snapshot when Server reports that it is live.
 */
export function shouldReconcileTerminalRecovery(
    previous: ProcessState,
    current: ProcessState,
): boolean {
    return previous !== 'running' && current === 'running';
}
