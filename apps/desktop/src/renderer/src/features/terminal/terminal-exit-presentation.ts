import type { ProcessState, TerminalFailureReason } from '@caxri/protocol';

export interface TerminalExitPresentation {
    /**
     * `pending` marks an in-progress automatic restore; it must never share the `unexpected` failure glyph, since
     * nothing has actually gone wrong yet.
     */
    icon: 'completed' | 'detached' | 'failed' | 'pending' | 'unexpected';
    label: string;
    /**
     * The longer explanation the recovery row's tooltip shows instead of repeating `label`, for a state whose cause the
     * short label cannot carry (where to change an automatic behavior).
     */
    detail?: string;
    tone: 'neutral' | 'danger';
}

/**
 * Actionable copy for each distinct `failed` cause; keep the generic fallback below in sync with unmapped codes.
 * Exported so other Terminal surfaces (e.g. the Info panel) render the same human copy instead of the raw enum value.
 */
export const FAILURE_REASON_LABELS: Record<TerminalFailureReason, string> = {
    working_directory_unavailable: 'Working directory no longer exists',
    executable_not_found: 'Agent CLI executable was not found',
    spawn_failed: 'Terminal process could not be started',
    agent_session_unavailable:
        'Original Agent Session could not be restored; check provider state or start fresh',
};

/**
 * Names the setting behind automatic suspension, so a user who wonders why their Agent restarted can find where to turn
 * it off. The record carries no suspension reason (an archive or a Process Explorer stop parks it the same way), so the
 * sentence describes the automatic rule without claiming it caused this particular park.
 */
export const SUSPENDED_DETAIL =
    'Caxri suspends background Agents to save memory and resumes them when you come back. Change when this happens in Settings > Agents.';

export function getTerminalExitPresentation(
    state: ProcessState,
    failureReason?: TerminalFailureReason,
    failureDetail?: string,
): TerminalExitPresentation | undefined {
    switch (state) {
        case 'stopped':
            return { icon: 'completed', label: 'Process exited normally', tone: 'neutral' };
        case 'failed':
            return {
                icon: 'failed',
                label:
                    failureDetail ??
                    (failureReason
                        ? FAILURE_REASON_LABELS[failureReason]
                        : 'Terminal failed to start'),
                tone: 'danger',
            };
        case 'dead':
            return { icon: 'unexpected', label: 'Terminal stopped unexpectedly', tone: 'danger' };
        case 'interrupted':
            return {
                icon: 'pending',
                label: 'Interrupted by app shutdown — restoring',
                tone: 'neutral',
            };
        case 'suspended':
            return {
                detail: SUSPENDED_DETAIL,
                icon: 'pending',
                label: 'Suspended in the background, resuming',
                tone: 'neutral',
            };
        case 'detached':
            return {
                icon: 'detached',
                label: 'Detached — resume when you are done elsewhere',
                tone: 'neutral',
            };
        case 'starting':
        case 'running':
            return undefined;
    }
}
