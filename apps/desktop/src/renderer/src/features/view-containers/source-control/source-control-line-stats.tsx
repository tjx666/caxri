import type { SourceControlResource } from '@caxri/protocol';

import { cn } from '../../../lib/utilities';

/**
 * The trailing `+N −M` on a Source Control file or directory row. Hidden from assistive technology because the row's
 * accessible name states the same counts in words.
 */
export function SourceControlLineStats({
    className,
    lineStats,
}: {
    className?: string;
    lineStats: SourceControlResource['lineStats'];
}) {
    if (!lineStats) return null;
    return (
        <span
            aria-hidden="true"
            className={cn('flex flex-none gap-1 diff-stat text-[11px]', className)}
        >
            <span className="text-success">+{lineStats.additions}</span>
            <span className="text-danger">−{lineStats.deletions}</span>
        </span>
    );
}
