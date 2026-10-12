import type { Translate } from '../i18n';
import { translate } from '../i18n';

/**
 * Localized counterparts of the worded `@caxri/protocol` usage formatters (`formatDuration`, `formatLimitWindowName`,
 * `formatLimitReset`). The protocol versions stay English because the CLI and the phone share them; these follow the
 * same thresholds so English output is byte-identical, and only the unit words change with the interface language.
 * Number-only formatters (`formatTokens`, `formatUsd`, `formatPercent`) need no counterpart: their `k`/`M`/`B` and `$`
 * suffixes read the same in every supported language.
 */

/**
 * Active time rounded to minutes (`45m`, `3h 20m`, `120h`).
 */
export function localizedDuration(ms: number, t: Translate = translate): string {
    const minutes = Math.round(ms / 60_000);
    if (minutes < 1)
        return ms > 0
            ? t('core.usageFormat.lessThanMinute')
            : t('core.usageFormat.minutes', { minutes: 0 });
    if (minutes < 60) return t('core.usageFormat.minutes', { minutes });
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 100)
        return rest > 0
            ? t('core.usageFormat.hoursMinutes', { hours, minutes: rest })
            : t('core.usageFormat.hours', { hours });
    // Grouped like the protocol's hand-rolled `groupThousands`, which matches `en-US` grouping.
    return t('core.usageFormat.hours', { hours: hours.toLocaleString('en-US') });
}

/**
 * A provider rate-limit window's name (`Weekly`, `5-hour`).
 */
export function localizedLimitWindowName(minutes: number, t: Translate = translate): string {
    if (minutes === 10_080) return t('core.usageFormat.window.weekly');
    if (minutes % 1_440 === 0) return t('core.usageFormat.window.days', { count: minutes / 1_440 });
    if (minutes % 60 === 0) return t('core.usageFormat.window.hours', { count: minutes / 60 });
    return t('core.usageFormat.window.minutes', { count: minutes });
}

/**
 * Share of a rate-limit window still available, whole percent. Every surface states what is left rather than what is
 * used, the way the Agent CLIs' own `/status` reads, since what is left is the figure a user plans the next turn by.
 */
export function remainingLimitPercent(usedPercent: number): number {
    return Math.round(Math.min(100, Math.max(0, 100 - usedPercent)));
}

/**
 * When a rate-limit window resets, relative to `now` (`resets in 3h 20m`, `resets in 4d 2h`).
 */
export function localizedLimitReset(at: number, now: number, t: Translate = translate): string {
    const ms = at - now;
    if (ms <= 0) return t('core.usageFormat.resetsNow');
    const hours = Math.floor(ms / 3_600_000);
    // A weekly window reads better in days than as `95h 59m`.
    if (hours >= 48)
        return t('core.usageFormat.resetsInDays', {
            days: Math.floor(hours / 24),
            hours: hours % 24,
        });
    return t('core.usageFormat.resetsIn', { duration: localizedDuration(ms, t) });
}
