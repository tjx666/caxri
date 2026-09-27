import type { ProcessState, TerminalFailureReason } from '@caxri/protocol';

export interface MobileTerminalExitPresentation {
    label: string;
    tone: 'muted' | 'danger';
}

/**
 * Mirrors Desktop's `FAILURE_REASON_LABELS`
 * (`apps/desktop/src/renderer/src/features/terminal/terminal-exit-presentation.ts`) so a failed Terminal reads the same
 * cause on both surfaces instead of a Runtime-authored string.
 */
const FAILURE_REASON_LABELS: Record<TerminalFailureReason, string> = {
    working_directory_unavailable: 'Working directory no longer exists',
    executable_not_found: 'Agent CLI executable was not found',
    spawn_failed: 'Terminal process could not be started',
    agent_session_unavailable:
        'Original Agent Session could not be restored; check provider state or start fresh',
};

/**
 * A stopped Terminal is not one state: `session-model.ts`'s `isMobileTerminalStopped` collapses `stopped`, `dead`,
 * `failed`, `interrupted`, `suspended`, and `detached` into a single boolean so the rest of the phone screen can treat
 * them alike, but that collapse must not reach the status chip a Session's Terminal renders — a clean exit and a crash
 * are different facts. This mirrors Desktop's `getTerminalExitPresentation` tone split: `failed` and `dead` are
 * unexpected stops (`danger`); `stopped` is a clean exit; `interrupted`, `suspended`, and `detached` are automatic
 * Desktop-side transitions rather than errors, so they stay `muted` exactly as Desktop's own `neutral` tone does for
 * the same three states.
 */
export const mobileTerminalExitPresentation = (
    state: Exclude<ProcessState, 'running' | 'starting'>,
    failureReason?: TerminalFailureReason,
): MobileTerminalExitPresentation => {
    switch (state) {
        case 'stopped':
            return { label: 'Terminal has stopped', tone: 'muted' };
        case 'dead':
            return { label: 'Terminal stopped unexpectedly', tone: 'danger' };
        case 'failed':
            return {
                label: failureReason
                    ? FAILURE_REASON_LABELS[failureReason]
                    : 'Terminal exited with an error',
                tone: 'danger',
            };
        case 'interrupted':
            return { label: 'Terminal is restoring on your computer', tone: 'muted' };
        case 'suspended':
            return { label: 'Terminal is paused on your computer', tone: 'muted' };
        case 'detached':
            return { label: 'Terminal was handed off on your computer', tone: 'muted' };
    }
};

/**
 * The status-chip presentation for a Session's primary Terminal, or `undefined` while it is still live.
 */
export const primaryTerminalExitPresentation = (
    terminal: { lastProcessState: ProcessState; failureReason?: TerminalFailureReason } | undefined,
): MobileTerminalExitPresentation | undefined =>
    terminal && terminal.lastProcessState !== 'running' && terminal.lastProcessState !== 'starting'
        ? mobileTerminalExitPresentation(terminal.lastProcessState, terminal.failureReason)
        : undefined;
