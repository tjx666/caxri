import type { GitFileStatus } from '@shared/types';

import { cn } from '../lib/utilities';

/**
 * Single-letter Git status badge (M/A/D/U/C…) colored by change kind, shared by Source Control and diff headers.
 */
export function GitFileStatusLetter({
    className,
    file,
}: {
    className?: string;
    file: GitFileStatus;
}) {
    return (
        <span
            className={cn(
                `status status-${file.kind}`,
                'min-w-4 flex-none text-center font-mono font-bold text-warning',
                (file.kind === 'added' || file.kind === 'untracked') && 'text-success',
                (file.kind === 'deleted' || file.kind === 'conflicted') && 'text-danger',
                className,
            )}
        >
            {file.index === ' ' ? file.workingTree : file.index}
        </span>
    );
}
