import type { ReactNode } from 'react';

import { useTranslation } from '../i18n';
import { cn } from '../lib/utilities';

/**
 * A titled section of a report page (Usage, Agent status), with an optional caption aligned to the title's baseline.
 */
export function ReportCard({
    title,
    caption,
    className,
    children,
}: {
    title: string;
    caption?: ReactNode;
    className?: string;
    children: ReactNode;
}) {
    return (
        <section
            aria-label={title}
            className={cn('min-w-0 rounded-md border border-border bg-surface p-4', className)}
        >
            <div className="mb-3 flex items-baseline justify-between gap-3">
                <h2 className="m-0 shrink-0 text-[13px] font-semibold">{title}</h2>
                {caption && (
                    <span className="min-w-0 truncate text-[11px] text-muted">{caption}</span>
                )}
            </div>
            {children}
        </section>
    );
}

/**
 * One headline figure. An undefined `value` is a figure that was not measured: it reads as a muted dash, announced as
 * "Not measured", and the tile's `detail` carries the reason, so the absence never looks like a zero or an error.
 */
export function StatTile({
    label,
    value,
    detail,
    wrapValue = false,
}: {
    label: string;
    value: string | undefined;
    detail?: ReactNode;
    /**
     * Keeps report fields such as a location or network organization fully visible instead of abbreviating them.
     */
    wrapValue?: boolean;
}) {
    const { t } = useTranslation();
    return (
        <div className="min-w-0 rounded-md border border-border bg-surface px-4 py-3">
            <div className="truncate text-[11px] text-muted">{label}</div>
            <div
                className={cn(
                    'mt-1 text-[15px] font-semibold tabular-nums',
                    wrapValue ? 'wrap-anywhere' : 'truncate',
                )}
            >
                {value ?? (
                    <>
                        <span aria-hidden="true" className="font-normal text-muted">
                            —
                        </span>
                        <span className="sr-only">{t('core.reportCard.notMeasured')}</span>
                    </>
                )}
            </div>
            {/*
             * Wraps rather than truncates, so a narrow tile still shows the whole caption. `text-pretty` keeps a lone
             * word off the last line; a caption holding two facts marks each `whitespace-nowrap` so it breaks between
             * them, not inside one.
             */}
            {detail && (
                <div className="mt-1 text-[11px] leading-snug text-pretty text-muted">{detail}</div>
            )}
        </div>
    );
}
