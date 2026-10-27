import type { AgentChatLabelTranslate } from '@caxri/protocol';
import {
    agentChatGoalDurationParts,
    isNoticeableDuration,
    shortDurationParts,
} from '@caxri/protocol';

type ElapsedTimeUnit = 'hours' | 'minutes' | 'seconds';

/**
 * One animated figure of an elapsed time with the label text around it, such as `8` with the suffix `m`.
 */
export interface ElapsedTimeFigure {
    unit: ElapsedTimeUnit;
    value: number;
    /**
     * The space before this figure, outside both figures, since a trailing space inside one would collapse.
     */
    separator: string;
    prefix: string;
    suffix: string;
}

/**
 * Private-use placeholders that no translation contains, so splitting a label on them recovers its literal text.
 */
const SLOTS: Record<ElapsedTimeUnit, string> = {
    hours: '\u{E002}',
    minutes: '\u{E000}',
    seconds: '\u{E001}',
};

const SLOT_UNITS = new Map(
    Object.entries(SLOTS).map(([unit, slot]) => [slot, unit as ElapsedTimeUnit]),
);

/**
 * Splits a translated duration label around its figures, so the units and their order stay the label's. The text after
 * a figure is its unit up to the first space; the space separates it from the next figure.
 */
function labelFigures(label: string, values: Record<ElapsedTimeUnit, number>): ElapsedTimeFigure[] {
    // [text, slot, text, slot, …, text]
    const parts = label.split(/([\u{E000}-\u{E002}])/u);
    const figures: ElapsedTimeFigure[] = [];
    let separator = '';
    for (let index = 1; index < parts.length; index += 2) {
        const unit = SLOT_UNITS.get(parts[index] ?? '');
        const after = parts[index + 1] ?? '';
        const isLast = index + 2 >= parts.length;
        const suffix = isLast ? after : after.trimEnd();
        if (unit)
            figures.push({
                unit,
                value: values[unit],
                separator,
                prefix: index === 1 ? (parts[0] ?? '') : '',
                suffix,
            });
        separator = after.slice(suffix.length);
    }
    return figures;
}

/**
 * The text a row of figures reads as, for `data-value` and tests.
 */
export function elapsedTimeText(figures: readonly ElapsedTimeFigure[]): string {
    return figures
        .map(({ separator, prefix, value, suffix }) => `${separator}${prefix}${value}${suffix}`)
        .join('');
}

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
): ElapsedTimeFigure[] | null {
    if (!isNoticeableDuration(durationMs)) return null;
    const { minutes, seconds } = shortDurationParts(durationMs);
    const values = { hours: 0, minutes, seconds };
    if (minutes === 0)
        return labelFigures(
            t('agentChat.fold.durationSeconds', { seconds: SLOTS.seconds }),
            values,
        );
    return labelFigures(
        t('agentChat.fold.durationMinutesSeconds', {
            minutes: SLOTS.minutes,
            seconds: SLOTS.seconds,
        }),
        values,
    );
}

/**
 * A goal's time as rolling figures, in the same units `formatAgentChatGoalDuration` writes (`1h 37m 29s`), so the
 * goal's time reads alike whether it ticks or rests. Unlike a turn's, it shows from zero: a goal row always has a
 * time.
 */
export function goalTimeFigures(seconds: number, t: AgentChatLabelTranslate): ElapsedTimeFigure[] {
    const values = agentChatGoalDurationParts(seconds);
    if (values.hours > 0)
        return labelFigures(
            t('agentChat.fold.durationHoursMinutesSeconds', {
                hours: SLOTS.hours,
                minutes: SLOTS.minutes,
                seconds: SLOTS.seconds,
            }),
            values,
        );
    if (values.minutes > 0)
        return labelFigures(
            t('agentChat.fold.durationMinutesSeconds', {
                minutes: SLOTS.minutes,
                seconds: SLOTS.seconds,
            }),
            values,
        );
    return labelFigures(t('agentChat.fold.durationSeconds', { seconds: SLOTS.seconds }), values);
}
