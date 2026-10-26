import type {
    ClaudeWindowBackgroundState,
    ClaudeWindowOutcome,
    ClaudeWindowState,
    ClaudeWindowStatus,
    ClaudeWindowUnavailableReason,
} from '@caxri/protocol';
import { CLAUDE_WINDOW_MINUTES } from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../../i18n';

const DAY_MINUTES = 1_440;
const DAY_MS = 86_400_000;

/**
 * `HH:MM` for a minute of the day, the value an `<input type="time">` reads and writes.
 */
export function formatMinuteOfDay(minutes: number): string {
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * The minute of the day in an `HH:MM` time input value, or undefined for an empty or malformed one.
 */
export function parseTimeInput(value: string): number | undefined {
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    if (!match) return undefined;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return undefined;
    return hours * 60 + minutes;
}

/**
 * When the warm-up window starts for a first workday reset: five hours earlier, wrapping past midnight.
 */
export function warmUpMinuteOfDay(firstWorkdayResetMinutes: number): number {
    return (firstWorkdayResetMinutes - CLAUDE_WINDOW_MINUTES + DAY_MINUTES) % DAY_MINUTES;
}

function startOfDay(time: number): number {
    const date = new Date(time);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * A local time with its day relative to `now`: `Today 05:00`, `Tomorrow 10:00`, or `10/28 15:01` further out.
 */
export function formatWindowTime(t: Translate, time: number, now: number): string {
    const date = new Date(time);
    const clock = formatMinuteOfDay(date.getHours() * 60 + date.getMinutes());
    const days = Math.round((startOfDay(time) - startOfDay(now)) / DAY_MS);
    if (days === 0) return t('settings.claudeWindows.time.today', { time: clock });
    if (days === 1) return t('settings.claudeWindows.time.tomorrow', { time: clock });
    if (days === -1) return t('settings.claudeWindows.time.yesterday', { time: clock });
    return t('settings.claudeWindows.time.date', {
        month: date.getMonth() + 1,
        day: date.getDate(),
        time: clock,
    });
}

const STATUS_KEYS: Record<ClaudeWindowStatus, TranslationKey> = {
    off: 'settings.claudeWindows.status.off',
    waitingForAnchor: 'settings.claudeWindows.status.waitingForAnchor',
    windowActive: 'settings.claudeWindows.status.windowActive',
    waitingForNaturalReset: 'settings.claudeWindows.status.waitingForNaturalReset',
    triggering: 'settings.claudeWindows.status.triggering',
    confirmed: 'settings.claudeWindows.status.confirmed',
    unavailable: 'settings.claudeWindows.status.unavailable',
};

const REASON_KEYS: Record<ClaudeWindowUnavailableReason, TranslationKey> = {
    notSignedIn: 'settings.claudeWindows.reason.notSignedIn',
    authUnsupported: 'settings.claudeWindows.reason.authUnsupported',
    planUnsupported: 'settings.claudeWindows.reason.planUnsupported',
    usageUnavailable: 'settings.claudeWindows.reason.usageUnavailable',
    weeklyLimit: 'settings.claudeWindows.reason.weeklyLimit',
    claudeNotFound: 'settings.claudeWindows.reason.claudeNotFound',
    probeFailed: 'settings.claudeWindows.reason.probeFailed',
};

const OUTCOME_KEYS: Record<ClaudeWindowOutcome, TranslationKey> = {
    natural_window_started: 'settings.claudeWindows.outcome.naturalWindowStarted',
    trigger_confirmed: 'settings.claudeWindows.outcome.triggerConfirmed',
    trigger_unverified: 'settings.claudeWindows.outcome.triggerUnverified',
    trigger_failed: 'settings.claudeWindows.outcome.triggerFailed',
    renewal_skipped: 'settings.claudeWindows.outcome.renewalSkipped',
    weekly_limit: 'settings.claudeWindows.outcome.weeklyLimit',
    auth_unsupported: 'settings.claudeWindows.outcome.authUnsupported',
    missed_while_asleep: 'settings.claudeWindows.outcome.missedWhileAsleep',
};

/**
 * Background job states that mean nothing wakes the keeper while Caxri is closed, though it is on.
 */
const BACKGROUND_WARNING_KEYS: Partial<Record<ClaudeWindowBackgroundState, TranslationKey>> = {
    unpackaged: 'settings.claudeWindows.background.unpackaged',
    unsupportedPlatform: 'settings.claudeWindows.background.unsupportedPlatform',
    registerFailed: 'settings.claudeWindows.background.registerFailed',
};

export interface ClaudeWindowsSummary {
    status: string;
    /**
     * Whether the status is a problem the user should notice.
     */
    isProblem: boolean;
    backgroundWarning?: string;
    lastOutcome?: string;
}

/**
 * The card's read-only lines for a keeper state.
 */
export function summarizeClaudeWindows(
    t: Translate,
    state: ClaudeWindowState,
    now: number,
): ClaudeWindowsSummary {
    const status =
        state.status === 'unavailable' && state.reason
            ? t('settings.claudeWindows.status.unavailableBecause', {
                  reason: t(REASON_KEYS[state.reason]),
              })
            : t(STATUS_KEYS[state.status], {
                  ...(state.windowResetsAt !== undefined && {
                      time: formatWindowTime(t, state.windowResetsAt, now),
                  }),
              });
    const backgroundKey = state.account?.keepRolling
        ? BACKGROUND_WARNING_KEYS[state.background]
        : undefined;
    const outcome = state.lastOutcome;
    return {
        status,
        isProblem: state.status === 'unavailable',
        ...(backgroundKey && { backgroundWarning: t(backgroundKey) }),
        ...(outcome && {
            lastOutcome: t('settings.claudeWindows.lastOutcome', {
                outcome: t(OUTCOME_KEYS[outcome.outcome]),
                time: formatWindowTime(t, outcome.at, now),
                missed:
                    outcome.missedPlannedAt === undefined
                        ? ''
                        : t('settings.claudeWindows.outcome.missedSuffix', {
                              time: formatWindowTime(t, outcome.missedPlannedAt, now),
                          }),
            }),
        }),
    };
}
