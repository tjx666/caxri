import type { UsageLimit } from '@caxri/protocol';
import { currentLimitWindows, remainingLimitPercent } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

/**
 * How often the open model sheet reads the plan limits again. The Server asks a running Claude Code Chat at most once a
 * minute, and Codex writes a new reading with each turn, so a faster poll would only repeat the same figures.
 */
export const AGENT_CHAT_PLAN_LIMITS_POLL_MS = 30_000;

/**
 * The share used at which a window reads in the warning tone, Desktop's `LIMIT_WARNING_PERCENT`.
 */
const LIMIT_WARNING_PERCENT = 90;

export interface AgentChatPlanLimitRow {
    key: string;
    /**
     * `5-hour limit`, `Weekly limit`: Desktop's hover card names.
     */
    label: string;
    /**
     * `62% left`: every surface states what is left, the figure a user plans the next turn by.
     */
    left: string;
    /**
     * Fills the bar: the share still available.
     */
    leftPercent: number;
    /**
     * `Resets in 3h 20m`, absent for a window the provider gave no reset time.
     */
    reset: string | undefined;
    /**
     * Epoch milliseconds the window resets, for a surface that also names the clock time.
     */
    resetsAt: number | undefined;
    isWarning: boolean;
}

function windowName(minutes: number, t: Translate): string {
    if (minutes === 10_080) return t('chat.model.limitWindowWeekly');
    if (minutes % 1_440 === 0) return t('chat.model.limitWindowDays', { count: minutes / 1_440 });
    if (minutes % 60 === 0) return t('chat.model.limitWindowHours', { count: minutes / 60 });
    return t('chat.model.limitWindowMinutes', { count: minutes });
}

function resetText(at: number, now: number, t: Translate): string {
    const minutes = Math.max(0, Math.round((at - now) / 60_000));
    if (minutes < 1) return t('chat.model.limitResetsSoon');
    const hours = Math.floor(minutes / 60);
    // A weekly window reads better in days than as `95h 59m`, as on Desktop.
    if (hours >= 48)
        return t('chat.model.limitResetsInDays', {
            days: Math.floor(hours / 24),
            hours: hours % 24,
        });
    if (hours > 0) return t('chat.model.limitResetsInHours', { hours, minutes: minutes % 60 });
    return t('chat.model.limitResetsInMinutes', { minutes });
}

/**
 * The model sheet's Plan limits rows, shortest window first, as Desktop's status bar reads `5h 62% · 7d 28% left`. A
 * window that has reset since the reading is left out rather than shown stale.
 */
export function agentChatPlanLimitRows(
    limit: UsageLimit | null | undefined,
    now: number,
    t: Translate = translate,
): AgentChatPlanLimitRow[] {
    return currentLimitWindows(limit, now).map((window) => {
        const leftPercent = remainingLimitPercent(window.usedPercent);
        return {
            key: String(window.windowMinutes),
            label: t('chat.model.limitName', { window: windowName(window.windowMinutes, t) }),
            left: t('chat.model.limitLeft', { percent: leftPercent }),
            leftPercent,
            reset: window.resetsAt === undefined ? undefined : resetText(window.resetsAt, now, t),
            resetsAt: window.resetsAt,
            isWarning: Math.round(window.usedPercent) >= LIMIT_WARNING_PERCENT,
        };
    });
}
