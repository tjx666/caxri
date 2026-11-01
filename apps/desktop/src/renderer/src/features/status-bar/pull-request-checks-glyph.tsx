import { Check, X } from 'lucide-react';

import { cn } from '../../lib/utilities';

/**
 * The CI verdict beside the status bar pull request number. Each verdict has its own shape, not only its own color, so
 * the verdict survives color-vision differences and a faint tone: passing is a check, failing a cross, still running a
 * filled dot, and cancelled an outlined ring. Decorative: the chip's accessible name and hover card state the verdict
 * in words.
 */
export function PullRequestChecksGlyph({
    checksKey,
    toneClassName,
}: {
    checksKey: string;
    toneClassName: string;
}) {
    const glyphClassName = cn('ml-1 inline-block size-2 shrink-0', toneClassName);
    switch (checksKey) {
        case 'passing':
            return (
                <Check
                    aria-hidden="true"
                    className={glyphClassName}
                    data-pull-request-checks={checksKey}
                    strokeWidth={4}
                />
            );
        case 'failing':
            return (
                <X
                    aria-hidden="true"
                    className={glyphClassName}
                    data-pull-request-checks={checksKey}
                    strokeWidth={4}
                />
            );
        case 'cancelled':
            return (
                <span
                    aria-hidden="true"
                    className={cn(glyphClassName, 'rounded-full border-[1.5px] border-current')}
                    data-pull-request-checks={checksKey}
                />
            );
        default:
            return (
                <span
                    aria-hidden="true"
                    className={cn(glyphClassName, 'rounded-full bg-current')}
                    data-pull-request-checks={checksKey}
                />
            );
    }
}
