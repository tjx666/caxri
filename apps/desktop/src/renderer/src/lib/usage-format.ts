import type { Translate } from '../i18n';
import { translate } from '../i18n';
import { formatCount } from './locale-format';

/**
 * Worded usage formatters (durations, rate-limit window names, reset times) whose unit words follow the interface
 * language. They have no `@caxri/protocol` counterpart. Number-only formatters (`formatTokens`, `formatUsd`,
 * `formatPercent`) stay in the protocol: their `k`/`M`/`B` and `$` suffixes read the same in every supported language.
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
    // Grouped in the app locale, like every other count on the usage surfaces.
    return t('core.usageFormat.hours', { hours: formatCount(hours) });
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
 * A rate-limit window's compact name for the status bar chip (`5h`, `wk`; `5 小时`, `本周`). The weekly window is a word
 * rather than `7d`, which reads as "7 days until reset" beside a remaining share; Orca's usage chip and the Codex CLI's
 * status line name it the same way.
 */
export function localizedShortLimitWindowName(minutes: number, t: Translate = translate): string {
    if (minutes === 10_080) return t('core.usageFormat.shortWindow.weekly');
    if (minutes % 1_440 === 0)
        return t('core.usageFormat.shortWindow.days', { count: minutes / 1_440 });
    if (minutes % 60 === 0) return t('core.usageFormat.shortWindow.hours', { count: minutes / 60 });
    return t('core.usageFormat.shortWindow.minutes', { count: minutes });
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
