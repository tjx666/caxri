import { formatLineCount } from '@caxri/protocol';

import { cn } from '../lib/utilities';

/**
 * The colored `+N −M` changed-line pair, shared by every surface that shows one (Source Control rows and captions,
 * commit history details, Session rows) so they all read the same. Counts are compact (`+1.9k −684`, see
 * `formatLineCount`), and the pair is hidden from assistive technology: each owner states the exact counts in words in
 * its own accessible name or description, where bare signed digits would read as arithmetic.
 */
export function DiffStat({
    additions,
    className,
    deletions,
}: {
    additions: number;
    className?: string;
    deletions: number;
}) {
    return (
        <span aria-hidden="true" className={cn('flex flex-none gap-1 diff-stat', className)}>
            <span className="text-success">+{formatLineCount(additions)}</span>
            <span className="text-danger">−{formatLineCount(deletions)}</span>
        </span>
    );
}
