import { useState } from 'react';

import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '../../components/ui/button';
import type { TranslationKey } from '../../i18n';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import type { UsageCustomRange, UsageRangeDraft } from './usage-custom-range';
import { draftSpan, monthWeeks, pickRangeDay, shiftMonth } from './usage-custom-range';
import { formatMonth, usageRangeLabel } from './usage-metrics';

const WEEKDAY_HEADINGS: readonly TranslationKey[] = [
    'usage.calendar.weekday.0',
    'usage.calendar.weekday.1',
    'usage.calendar.weekday.2',
    'usage.calendar.weekday.3',
    'usage.calendar.weekday.4',
    'usage.calendar.weekday.5',
    'usage.calendar.weekday.6',
];

/**
 * The custom range picker: one month at a time, a first click picks the start and a second the end (in either order),
 * with the span previewed under the pointer before the second click. Days after `today` hold no usage and are disabled.
 * Nothing applies until Apply, so a half-picked range never reloads the report.
 */
export function UsageRangeCalendar({
    initial,
    today,
    onApply,
}: {
    initial: UsageCustomRange | undefined;
    today: string;
    onApply: (range: UsageCustomRange) => void;
}) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<UsageRangeDraft | undefined>(initial);
    const [hovered, setHovered] = useState<string>();
    const [month, setMonth] = useState(() => (initial?.end ?? today).slice(0, 7));
    const span = draftSpan(draft, hovered);
    const complete = draft?.end === undefined ? undefined : { start: draft.start, end: draft.end };
    return (
        <div
            aria-label={t('usage.calendar.label')}
            className="flex flex-col gap-2 p-3"
            role="group"
        >
            <div className="flex items-center justify-between">
                <Button
                    aria-label={t('usage.calendar.previousMonth')}
                    size="icon"
                    variant="ghost"
                    onClick={() => setMonth(shiftMonth(month, -1))}
                >
                    <ChevronLeft aria-hidden="true" className="size-3.5" />
                </Button>
                <span className="text-[12px] font-medium">{formatMonth(t, month)}</span>
                <Button
                    aria-label={t('usage.calendar.nextMonth')}
                    disabled={month >= today.slice(0, 7)}
                    size="icon"
                    variant="ghost"
                    onClick={() => setMonth(shiftMonth(month, 1))}
                >
                    <ChevronRight aria-hidden="true" className="size-3.5" />
                </Button>
            </div>
            <table className="w-full border-collapse text-center text-[11px] tabular-nums">
                <thead>
                    <tr>
                        {WEEKDAY_HEADINGS.map((key) => (
                            <th key={key} className="h-6 font-normal text-muted" scope="col">
                                {t(key)}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody onPointerLeave={() => setHovered(undefined)}>
                    {monthWeeks(month).map((week) => (
                        <tr key={week.find(Boolean)}>
                            {week.map((day, index) => {
                                if (!day) return <td key={`blank-${index}`} />;
                                const isEndpoint = day === span?.start || day === span?.end;
                                const isInSpan =
                                    span !== undefined && day >= span.start && day <= span.end;
                                return (
                                    <td key={day} className="p-0">
                                        <button
                                            aria-pressed={isInSpan}
                                            className={cn(
                                                'h-7 w-full cursor-pointer rounded-md border-0 bg-transparent text-[11px] text-foreground tabular-nums outline-none hover:bg-state-hover focus-visible:shadow-[0_0_0_2px_var(--accent)] disabled:cursor-not-allowed disabled:text-muted disabled:opacity-50',
                                                isInSpan && 'bg-accent/15',
                                                isEndpoint &&
                                                    'bg-accent text-accent-foreground hover:bg-accent',
                                                day === today && !isEndpoint && 'font-semibold',
                                            )}
                                            disabled={day > today}
                                            type="button"
                                            onClick={() => setDraft(pickRangeDay(draft, day))}
                                            onPointerEnter={() => setHovered(day)}
                                        >
                                            {Number(day.slice(8))}
                                        </button>
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
            <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-[11px] text-muted">
                    {complete ? usageRangeLabel(t, 'custom', complete) : t('usage.calendar.hint')}
                </span>
                <Button
                    disabled={!complete}
                    size="sm"
                    onClick={() => {
                        if (complete) onApply(complete);
                    }}
                >
                    {t('usage.calendar.apply')}
                </Button>
            </div>
        </div>
    );
}
