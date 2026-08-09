import type { ReactNode } from 'react';

import { cn } from '../../lib/utils';

interface DisclosureMotionProps {
    animate: boolean;
    children: ReactNode;
    className?: string;
    expanded: boolean;
    hidden?: boolean;
    kind: 'archive' | 'project';
}

/**
 * Keeps disclosure contents mounted during collapse so CSS grid can interpolate intrinsic height.
 * `inert` removes the visually clipped controls from focus and accessibility navigation immediately.
 */
export function DisclosureMotion({
    animate,
    children,
    className,
    expanded,
    hidden = false,
    kind,
}: DisclosureMotionProps) {
    const interactive = expanded && !hidden;
    return (
        <div
            className={cn('disclosure-motion grid', hidden && 'hidden', className)}
            data-disclosure={kind}
            data-expanded={expanded}
            data-motion={animate || undefined}
            aria-hidden={!interactive}
            inert={!interactive ? true : undefined}
        >
            <div className="min-h-0 overflow-hidden">{children}</div>
        </div>
    );
}
