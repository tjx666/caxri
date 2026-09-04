import type { ReactNode } from 'react';

import type { LucideIcon } from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';

const statusInfoClassName =
    'statusbar-info inline-flex h-5 min-w-0 flex-none items-center gap-[5px] overflow-hidden rounded px-[5px] text-foreground [&>svg]:flex-none [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap';

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
    icon: Icon,
    title,
}: {
    announce?: boolean;
    ariaLabel: string;
    children: ReactNode;
    className?: string;
    icon?: LucideIcon;
    title: ReactNode;
}) {
    return (
        <Tooltip content={title}>
            <span
                aria-label={ariaLabel}
                aria-live={announce ? 'polite' : undefined}
                className={cn(statusInfoClassName, className)}
                role={announce ? 'status' : undefined}
            >
                {Icon && <Icon size={12} />}
                <span>{children}</span>
            </span>
        </Tooltip>
    );
}
