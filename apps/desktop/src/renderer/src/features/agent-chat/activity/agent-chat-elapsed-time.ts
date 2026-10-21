import type { AgentChatLabelTranslate } from '@caxri/protocol';
import { isNoticeableDuration, shortDurationParts } from '@caxri/protocol';

/**
 * One animated figure of the elapsed time with the label text around it, such as `8` with the suffix `m`.
 */
export interface ElapsedTimeFigure {
    value: number;
    prefix: string;
    suffix: string;
}

/**
 * Private-use placeholders that no translation contains, so splitting a label on them recovers its literal text.
 */
const MINUTES_SLOT = '\u{E000}';
const SECONDS_SLOT = '\u{E001}';

/**
 * The running turn's elapsed time as the figures the composer strip rolls: seconds alone under a minute, then minutes
 * and seconds. Units and their order come from the same `agentChat.fold.duration*` labels a finished turn's duration
 * uses (`8m 54s`, `8 分 54 秒`), so the live time and the settled one read alike. Unlike the settled label, a whole
 * minute keeps `0s`: the live time ticks every second, and dropping the seconds for one tick would fade them out and
 * back in. `null` while the time is too short to show (`isNoticeableDuration`).
 */
export function elapsedTimeFigures(
    durationMs: number,
    t: AgentChatLabelTranslate,
): { minutes?: ElapsedTimeFigure; separator: string; seconds: ElapsedTimeFigure } | null {
    if (!isNoticeableDuration(durationMs)) return null;
    const { minutes, seconds } = shortDurationParts(durationMs);
    if (minutes === 0) {
        const [prefix = '', suffix = ''] = t('agentChat.fold.durationSeconds', {
            seconds: SECONDS_SLOT,
        }).split(SECONDS_SLOT);
        return { separator: '', seconds: { value: seconds, prefix, suffix } };
    }
    const [prefix = '', between = '', suffix = ''] = t('agentChat.fold.durationMinutesSeconds', {
        minutes: MINUTES_SLOT,
        seconds: SECONDS_SLOT,
    }).split(/[\u{E000}\u{E001}]/u, 3);
    // The space between the two figures sits outside both, since a trailing space inside one would collapse.
    const minuteSuffix = between.trimEnd();
    return {
        minutes: { value: minutes, prefix, suffix: minuteSuffix },
        separator: between.slice(minuteSuffix.length),
        seconds: { value: seconds, prefix: '', suffix },
    };
}
