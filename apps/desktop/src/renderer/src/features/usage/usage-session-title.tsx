import { useRef } from 'react';

import type { UsageSessionRow } from '@caxri/protocol';

import { Tooltip } from '../../components/ui/tooltip';
import { useIsOverflowing } from '../../hooks/use-is-overflowing';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { openSession } from '../session/session-commands';
import { canOpenUsageSession } from './usage-metrics';
import { usageSessionTitle } from './usage-presentation';

/**
 * A Most expensive Sessions title. A Session that still exists in the PrimarySidebar is a button that switches to it;
 * an archived or deleted one, or an Agent Session run outside Caxri (titled by its folder), stays plain text. A clipped
 * title raises the shared Tooltip with the full name; an unclipped one would only repeat what is already on screen.
 */
export function UsageSessionTitle({ row }: { row: UsageSessionRow }) {
    const { t } = useTranslation();
    const reference = useRef<HTMLElement>(null);
    const title = usageSessionTitle(t, row);
    const isClipped = useIsOverflowing(reference, title);
    const canOpen = canOpenUsageSession(row);
    const className = cn('min-w-0 truncate', (row.isDeleted || row.isOutsideCaxri) && 'text-muted');
    return (
        <Tooltip content={title} disabled={!isClipped}>
            {canOpen ? (
                <button
                    ref={(element) => {
                        reference.current = element;
                    }}
                    type="button"
                    aria-label={t('usage.sessions.open', { title })}
                    className={cn(
                        className,
                        'cursor-pointer rounded-sm border-0 bg-transparent p-0 text-left text-[12px] text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none',
                    )}
                    onClick={() => openSession(row.sessionId)}
                >
                    {title}
                </button>
            ) : (
                <span
                    ref={(element) => {
                        reference.current = element;
                    }}
                    className={className}
                >
                    {title}
                </span>
            )}
        </Tooltip>
    );
}
