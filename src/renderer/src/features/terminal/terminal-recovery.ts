import type { ProcessState } from '@shared/types';

/**
A PTY mounted before launch needs one final-grid snapshot when Runtime reports that it is live.
 */
export function shouldReconcileTerminalRecovery(
    previous: ProcessState,
    current: ProcessState,
): boolean {
    return previous !== 'running' && current === 'running';
}
