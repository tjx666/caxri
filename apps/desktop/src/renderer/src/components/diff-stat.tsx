import { formatLineCount, visibleDiffStatParts } from '@caxri/protocol';

import { cn } from '../lib/utilities';

/**
 * The colored `+N -M` changed-line pair, shared by every surface that shows one (Source Control rows and captions,
 * commit history details, Session rows) so they all read the same. Counts are compact (`+1.9k -684`, see
 * `formatLineCount`), a zero half beside a non-zero one is omitted (see `visibleDiffStatParts`), and the pair is hidden
 * from assistive technology: each owner states the exact counts in words in its own accessible name or description,
 * where bare signed digits would read as arithmetic.
 *
 * The colors are `--diff-stat-added` / `--diff-stat-removed`, the theme's success and danger moved to one lightness
 * (see `diffStatColors`), and the signs are dimmed so the figures carry the weight.
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
    const visible = visibleDiffStatParts({ additions, deletions });
    return (
        <span aria-hidden="true" className={cn('flex flex-none gap-1 diff-stat', className)}>
            {visible.additions && (
                <span className="text-diff-stat-added">
                    <DiffStatSign sign="+" />
                    {formatLineCount(additions)}
                </span>
            )}
            {visible.deletions && (
                <span className="text-diff-stat-removed">
                    <DiffStatSign sign="-" />
                    {formatLineCount(deletions)}
                </span>
            )}
        </span>
    );
}

/**
 * A dimmed `+` or `-`.
 */
function DiffStatSign({ sign }: { sign: '+' | '-' }) {
    return <span className="opacity-60">{sign}</span>;
}
