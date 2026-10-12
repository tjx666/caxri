import type { ProcessState, TerminalFailureReason } from '@caxri/protocol';

import type { TranslationKey } from '../../i18n';
import { translate } from '../../i18n';
import { settingCategoryPath } from '../settings/setting-spec-text';

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
 * Actionable copy for each distinct `failed` cause, exported so other Terminal surfaces (e.g. the Info panel) render
 * the same human copy instead of the raw enum value; keep the generic fallback below in sync with unmapped codes.
 */
export const FAILURE_REASON_LABEL_KEYS: Record<TerminalFailureReason, TranslationKey> = {
    working_directory_unavailable: 'terminal.exit.failure.workingDirectoryUnavailable',
    executable_not_found: 'terminal.exit.failure.executableNotFound',
    spawn_failed: 'terminal.exit.failure.spawnFailed',
    agent_session_unavailable: 'terminal.exit.failure.agentSessionUnavailable',
};

/**
 * Names the setting behind automatic suspension, so a user who wonders why their Agent restarted can find where to turn
 * it off. The record carries no suspension reason (an archive or a Process Explorer stop parks it the same way), so the
 * sentence describes the automatic rule without claiming it caused this particular park.
 */
export function suspendedDetail(): string {
    return translate('terminal.exit.suspendedDetail', {
        settingsPath: settingCategoryPath(translate, 'terminal.idleSuspension.enabled'),
    });
}

export function getTerminalExitPresentation(
    state: ProcessState,
    failureReason?: TerminalFailureReason,
    failureDetail?: string,
): TerminalExitPresentation | undefined {
    switch (state) {
        case 'stopped':
            return {
                icon: 'completed',
                label: translate('terminal.exit.stopped'),
                tone: 'neutral',
            };
        case 'failed':
            return {
                icon: 'failed',
                label:
                    failureDetail ??
                    translate(
                        failureReason
                            ? FAILURE_REASON_LABEL_KEYS[failureReason]
                            : 'terminal.exit.failed',
                    ),
                tone: 'danger',
            };
        case 'dead':
            return {
                icon: 'unexpected',
                label: translate('terminal.exit.dead'),
                tone: 'danger',
            };
        case 'interrupted':
            return {
                icon: 'pending',
                label: translate('terminal.exit.interrupted'),
                tone: 'neutral',
            };
        case 'suspended':
            return {
                detail: suspendedDetail(),
                icon: 'pending',
                label: translate('terminal.exit.suspended'),
                tone: 'neutral',
            };
        case 'detached':
            return {
                icon: 'detached',
                label: translate('terminal.exit.detached'),
                tone: 'neutral',
            };
        case 'starting':
        case 'running':
            return undefined;
    }
}
