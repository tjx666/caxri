import type { ReactNode, Ref } from 'react';

import { cn } from '../lib/utilities';
import { FOCUSABLE_TOOLTIP_TRIGGER_CLASS, Tooltip } from './ui/tooltip';

interface PanelHeaderProperties {
    /**
     * Toolbar actions pinned to the trailing edge. Hover-revealed actions stay the caller's business; the header only
     * owns the row's geometry and the title's typography.
     */
    actions?: ReactNode;
    className?: string;
    ref?: Ref<HTMLDivElement>;
    /**
     * Native `title` attribute for the caption, for a name the row may truncate.
     */
    titleAttribute?: string;
    title: ReactNode;
}

const titleClassName =
    'panel-caption-title min-w-0 flex-1 truncate text-[11px] font-bold tracking-[0.04em] text-foreground uppercase';

/**
 * The one caption row every SecondarySidebar panel wears.
 *
 * Each panel used to hand-roll its own: the Files caption was plain 11px muted text, Source Control inherited the
 * default size beside an icon, and Project Status was bold uppercase with tracking. Three treatments for one role read
 * as three unrelated surfaces. This settles on the Status panel's treatment, which is also VS Code's section caption (
 * small, bold, uppercase, letter-spaced), so a workspace name reads as a heading instead of a stray label.
 *
 * The caption is a real `<h3>`, not a styled `<span>`: the multi-view container in `view-container-surface.tsx` shipped
 * its own `<h3>` before it was migrated here, and a screen reader's heading list is how a keyboard user jumps between
 * the views stacked inside one container. Tailwind's preflight already resets heading margin and size, so the element
 * change carries no visual weight of its own.
 */
export function PanelHeader({
    actions,
    className,
    ref,
    title,
    titleAttribute,
}: PanelHeaderProperties) {
    return (
        <div
            ref={ref}
            className={cn(
                'panel-caption flex min-h-[34px] items-center gap-1 border-b border-border pt-[3px] pr-1 pb-[3px] pl-2.5',
                className,
            )}
        >
            {titleAttribute === undefined ? (
                <h3 className={titleClassName}>{title}</h3>
            ) : (
                <Tooltip content={titleAttribute}>
                    <h3
                        className={cn(titleClassName, FOCUSABLE_TOOLTIP_TRIGGER_CLASS)}
                        tabIndex={0}
                    >
                        {title}
                    </h3>
                </Tooltip>
            )}
            {actions !== undefined && (
                <span className="panel-caption-actions flex flex-none items-center gap-0.5">
                    {actions}
                </span>
            )}
        </div>
    );
}
