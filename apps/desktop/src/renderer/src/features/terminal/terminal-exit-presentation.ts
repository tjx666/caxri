import type { ProcessState, TerminalFailureReason } from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import { settingCategoryPath } from '../settings/setting-spec-text';
import type { TerminalExitInfo } from './terminal-exit-info';
import { EARLY_EXIT_THRESHOLD_MS } from './terminal-exit-info';

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
    pty_exhausted: 'terminal.exit.failure.ptyExhausted',
};

/**
 * Names the setting behind automatic suspension, so a user who wonders why their Agent restarted can find where to turn
 * it off. The record carries no suspension reason (an archive or a Process Explorer stop parks it the same way), so the
 * sentence describes the automatic rule without claiming it caused this particular park.
 */
export function suspendedDetail(t: Translate): string {
    return t('terminal.exit.suspendedDetail', {
        settingsPath: settingCategoryPath(t, 'terminal.idleSuspension.enabled'),
    });
}

/**
 * Names for the signals a Terminal process is realistically ended by; anything else shows its number.
 */
const SIGNAL_NAMES: Record<number, string> = {
    1: 'SIGHUP',
    2: 'SIGINT',
    3: 'SIGQUIT',
    4: 'SIGILL',
    6: 'SIGABRT',
    9: 'SIGKILL',
    11: 'SIGSEGV',
    13: 'SIGPIPE',
    15: 'SIGTERM',
};

function exitReasonText(exit: TerminalExitInfo, t: Translate): string {
    return exit.signal
        ? t('terminal.exit.reason.signal', {
              signal: SIGNAL_NAMES[exit.signal] ?? String(exit.signal),
          })
        : t('terminal.exit.reason.code', { code: exit.exitCode });
}

export interface TerminalExitContext {
    /**
     * Exit code, signal, and run length from the `terminal.exit` event.
     */
    exit?: TerminalExitInfo;
    /**
     * True for an Agent Terminal, which gets the "exited right after starting" wording on an early failure.
     */
    isAgent?: boolean;
    /**
     * The Terminal's launch directory, named when it is the thing that went missing.
     */
    cwd?: string;
}

function deadLabel(context: TerminalExitContext | undefined, t: Translate): string {
    const exit = context?.exit;
    if (!exit) return t('terminal.exit.dead');
    const reason = exitReasonText(exit, t);
    if (context.isAgent && exit.ranForMs !== undefined && exit.ranForMs < EARLY_EXIT_THRESHOLD_MS)
        return t('terminal.exit.agentEarly', { reason });
    return t('terminal.exit.deadWithReason', { reason });
}

export function getTerminalExitPresentation(
    state: ProcessState,
    failureReason: TerminalFailureReason | undefined,
    failureDetail: string | undefined,
    context: TerminalExitContext | undefined,
    t: Translate,
): TerminalExitPresentation | undefined {
    switch (state) {
        case 'stopped':
            return {
                icon: 'completed',
                label: t('terminal.exit.stopped'),
                tone: 'neutral',
            };
        case 'failed':
            return {
                icon: 'failed',
                label:
                    failureDetail ??
                    (failureReason === 'working_directory_unavailable' && context?.cwd
                        ? t('terminal.exit.failure.workingDirectoryUnavailableAt', {
                              path: context.cwd,
                          })
                        : t(
                              failureReason
                                  ? FAILURE_REASON_LABEL_KEYS[failureReason]
                                  : 'terminal.exit.failed',
                          )),
                tone: 'danger',
            };
        case 'dead':
            return {
                icon: 'unexpected',
                label: deadLabel(context, t),
                tone: 'danger',
            };
        case 'interrupted':
            return {
                icon: 'pending',
                label: t('terminal.exit.interrupted'),
                tone: 'neutral',
            };
        case 'suspended':
            return {
                detail: suspendedDetail(t),
                icon: 'pending',
                label: t('terminal.exit.suspended'),
                tone: 'neutral',
            };
        case 'detached':
            return {
                icon: 'detached',
                label: t('terminal.exit.detached'),
                tone: 'neutral',
            };
        case 'starting':
        case 'running':
            return undefined;
    }
}
