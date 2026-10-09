import type { ReactElement, ReactNode } from 'react';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../components/ui/hover-card';
import { Tooltip } from '../../components/ui/tooltip';

/**
 * The hover surface behind every status-bar entry. A plain reading uses the shared Tooltip; a card that carries its own
 * links (the Linear chip's other referenced issues) switches to the PreviewCard surface, because a Tooltip closes as
 * soon as the pointer leaves the trigger and its links could never be clicked. The card keeps the Tooltip's compact
 * look and `.tooltip-popup` hook so the two read, and are found by E2E, as one surface.
 */
export function StatusTooltip({
    children,
    content,
    interactive = false,
}: {
    children: ReactElement<Record<string, unknown>>;
    content: ReactNode;
    interactive?: boolean;
}) {
    if (!interactive) return <Tooltip content={content}>{children}</Tooltip>;
    return (
        <HoverCard>
            {/* A slightly longer close delay than the Tooltip's 80ms gives the pointer time to cross the gap. */}
            <HoverCardTrigger closeDelay={150} delay={500} render={children} />
            <HoverCardContent
                className="tooltip-popup w-auto max-w-80 rounded-md border-0 px-2.5 py-1.5 text-[12px] shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)]"
                collisionPadding={8}
            >
                {content}
            </HoverCardContent>
        </HoverCard>
    );
}
