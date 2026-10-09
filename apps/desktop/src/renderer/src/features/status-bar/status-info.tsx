import type { ReactNode } from 'react';

import { cn } from '../../lib/utilities';
import { StatusTooltip } from './status-tooltip';

/**
 * Sized in CSS for the reason given on `statusItemClassName`; a read-only reading sits at the `dense` type tier, one
 * pixel smaller.
 */
const statusInfoClassName =
    'statusbar-info inline-flex h-5 min-w-0 flex-none items-center gap-[5px] overflow-hidden rounded px-[5px] text-foreground tabular-nums [&>svg]:flex-none [&>svg]:size-[12px] [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap';

/**
 * A read-only status-bar reading. DESIGN.md requires explanatory prose in both the accessible name and a hover tooltip:
 * an `aria-label` alone leaves sighted mouse users with less information than assistive tech gets. Wrapped in the
 * shared `Tooltip` primitive rather than a bare `title` attribute so it renders consistently (and visibly) instead of
 * relying on Chromium's native, easy-to-miss tooltip.
 */
export function StatusInfo({
    announce,
    ariaLabel,
    children,
    className,
    focusable = false,
    icon,
    interactiveTitle,
    title,
}: {
    announce?: boolean;
    ariaLabel: string;
    children: ReactNode;
    className?: string;
    focusable?: boolean;
    icon?: ReactNode;
    /**
     * Same contract as `StatusItem`'s `interactiveTitle`.
     */
    interactiveTitle?: boolean;
    title: ReactNode;
}) {
    return (
        <StatusTooltip content={title} interactive={interactiveTitle}>
            <span
                aria-label={ariaLabel}
                aria-live={announce ? 'polite' : undefined}
                className={cn(
                    statusInfoClassName,
                    focusable &&
                        'focus-visible:shadow-[0_0_0_1px_var(--foreground)] focus-visible:outline-none',
                    className,
                )}
                role={announce ? 'status' : focusable ? 'note' : undefined}
                tabIndex={focusable ? 0 : undefined}
            >
                {icon}
                <span>{children}</span>
            </span>
        </StatusTooltip>
    );
}
