import type { ProcessState, TerminalFailureReason } from '@shared/types';

export interface TerminalExitPresentation {
    icon: 'completed' | 'failed' | 'unexpected';
    label: string;
    tone: 'neutral' | 'danger';
}

/** Actionable copy for each distinct `failed` cause; keep the generic fallback below in sync with unmapped codes. */
const FAILURE_REASON_LABELS: Record<TerminalFailureReason, string> = {
    working_directory_unavailable: 'Working directory no longer exists',
    executable_not_found: 'Agent CLI executable was not found',
    spawn_failed: 'Terminal process could not be started',
};

export function getTerminalExitPresentation(
    state: ProcessState,
    failureReason?: TerminalFailureReason,
): TerminalExitPresentation | undefined {
    switch (state) {
        case 'stopped':
            return { icon: 'completed', label: 'Process exited normally', tone: 'neutral' };
        case 'failed':
            return {
                icon: 'failed',
                label: failureReason
                    ? FAILURE_REASON_LABELS[failureReason]
                    : 'Terminal failed to start',
                tone: 'danger',
            };
        case 'dead':
            return { icon: 'unexpected', label: 'Terminal stopped unexpectedly', tone: 'danger' };
        case 'interrupted':
            return {
                icon: 'unexpected',
                label: 'Interrupted by app shutdown — restoring',
                tone: 'neutral',
            };
        case 'starting':
        case 'running':
            return undefined;
    }
}
