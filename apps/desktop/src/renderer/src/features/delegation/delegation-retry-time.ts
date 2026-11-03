import type { Translate } from '../../i18n';
import { localeDateTimeFormat } from '../../lib/locale-format';

/**
 * The absolute local time a scheduled retry runs, in the interface language: `3:05 PM` today, and with the date (`Nov
 * 5, 3:05 PM`) on any other day. Absolute on purpose: a relative "in 3h" would drift against the row's minute tick and
 * says nothing about the day a limit that resets tomorrow runs.
 */
export function formatRetryTime(at: number, now: number, t: Translate): string {
    const isToday = new Date(at).toDateString() === new Date(now).toDateString();
    return localeDateTimeFormat(
        isToday
            ? { hour: 'numeric', minute: '2-digit' }
            : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
        t.locale,
    ).format(at);
}
