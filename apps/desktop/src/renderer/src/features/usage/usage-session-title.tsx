import { useRef } from 'react';

import type { UsageSessionRow } from '@caxri/protocol';

import { Tooltip } from '../../components/ui/tooltip';
import { useIsOverflowing } from '../../hooks/use-is-overflowing';
import { cn } from '../../lib/utilities';
import { openSession } from '../session/session-commands';
import { canOpenUsageSession } from './usage-metrics';

/**
 * A Most expensive Sessions title. A Session that still exists in the PrimarySidebar is a button that switches to it;
 * an archived or deleted one, or an Agent Session run outside Caxri (titled by its folder), stays plain text. A clipped
 * title raises the shared Tooltip with the full name; an unclipped one would only repeat what is already on screen.
 */
export function UsageSessionTitle({ row }: { row: UsageSessionRow }) {
    const reference = useRef<HTMLElement>(null);
    const isClipped = useIsOverflowing(reference, row.title);
    const canOpen = canOpenUsageSession(row);
    const className = cn('min-w-0 truncate', (row.isDeleted || row.isOutsideCaxri) && 'text-muted');
    return (
        <Tooltip content={row.title} disabled={!isClipped}>
            {canOpen ? (
                <button
                    ref={(element) => {
                        reference.current = element;
                    }}
                    type="button"
                    aria-label={`Open Session ${row.title}`}
                    className={cn(
                        className,
                        'cursor-pointer rounded-sm border-0 bg-transparent p-0 text-left text-[12px] text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none',
                    )}
                    onClick={() => openSession(row.sessionId)}
                >
                    {row.title}
                </button>
            ) : (
                <span
                    ref={(element) => {
                        reference.current = element;
                    }}
                    className={className}
                >
                    {row.title}
                </span>
            )}
        </Tooltip>
    );
}
