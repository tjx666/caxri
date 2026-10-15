import type { ProcessState, TerminalFailureReason } from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import { translate } from '../../i18n';

export interface MobileTerminalExitPresentation {
    label: string;
    tone: 'muted' | 'danger';
}

/**
 * Mirrors Desktop's `FAILURE_REASON_LABELS`
 * (`apps/desktop/src/renderer/src/features/terminal/terminal-exit-presentation.ts`) so a failed Terminal reads the same
 * cause on both surfaces instead of a Runtime-authored string.
 */
const FAILURE_REASON_LABELS: Record<TerminalFailureReason, TranslationKey> = {
    working_directory_unavailable: 'terminal.exit.failure.workingDirectoryUnavailable',
    executable_not_found: 'terminal.exit.failure.executableNotFound',
    spawn_failed: 'terminal.exit.failure.spawnFailed',
    agent_session_unavailable: 'terminal.exit.failure.agentSessionUnavailable',
};

/**
 * A stopped Terminal is not one state: `session-model.ts`'s `isMobileTerminalStopped` collapses `stopped`, `dead`,
 * `failed`, `interrupted`, `suspended`, and `detached` into a single boolean so the rest of the phone screen can treat
 * them alike, but that collapse must not reach the status chip a Session's Terminal renders: a clean exit and a crash
 * are different facts. This mirrors Desktop's `getTerminalExitPresentation` tone split: `failed` and `dead` are
 * unexpected stops (`danger`); `stopped` is a clean exit; `interrupted`, `suspended`, and `detached` are automatic
 * Desktop-side transitions rather than errors, so they stay `muted` exactly as Desktop's own `neutral` tone does for
 * the same three states.
 */
export const mobileTerminalExitPresentation = (
    state: Exclude<ProcessState, 'running' | 'starting'>,
    failureReason?: TerminalFailureReason,
    t: Translate = translate,
): MobileTerminalExitPresentation => {
    switch (state) {
        case 'stopped':
            return { label: t('terminal.exit.stopped'), tone: 'muted' };
        case 'dead':
            return { label: t('terminal.exit.dead'), tone: 'danger' };
        case 'failed':
            return {
                label: t(
                    failureReason ? FAILURE_REASON_LABELS[failureReason] : 'terminal.exit.failed',
                ),
                tone: 'danger',
            };
        case 'interrupted':
            return { label: t('terminal.exit.interrupted'), tone: 'muted' };
        case 'suspended':
            return { label: t('terminal.exit.suspended'), tone: 'muted' };
        case 'detached':
            return { label: t('terminal.exit.detached'), tone: 'muted' };
    }
};

/**
 * The status-chip presentation for a Session's primary Terminal, or `undefined` while it is still live.
 */
export const primaryTerminalExitPresentation = (
    terminal: { lastProcessState: ProcessState; failureReason?: TerminalFailureReason } | undefined,
    t: Translate = translate,
): MobileTerminalExitPresentation | undefined =>
    terminal && terminal.lastProcessState !== 'running' && terminal.lastProcessState !== 'starting'
        ? mobileTerminalExitPresentation(terminal.lastProcessState, terminal.failureReason, t)
        : undefined;
