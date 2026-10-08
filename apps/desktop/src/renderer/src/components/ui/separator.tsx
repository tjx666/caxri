import { Separator as SeparatorPrimitive } from '@base-ui/react/separator';

import { cn } from '@/lib/utilities';

/**
 * The sanctioned standalone divider line. Divider decision guide:
 *
 * - Chrome-region seams (PrimarySidebar, tab strip, SecondarySidebar, status bar) use `bg-surface`/`bg-background` steps,
 *   never lines, enforced by the renderer design contract test.
 * - A free-standing line between siblings (e.g. grouping items in a menu-like list) uses Separator.
 * - A line that belongs to an element's own box stays a `border-* border-border` utility on that element: sticky headers
 *   that must carry their line while pinned, per-cell column rules, and framed input wrappers.
 * - Menu-scoped separators keep their scoped primitives (`ContextMenuSeparator`), matching the shadcn upstream
 *   convention.
 */
export function Separator({ className, ...properties }: SeparatorPrimitive.Props) {
    return (
        <SeparatorPrimitive
            data-slot="separator"
            className={cn(
                'shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
                className,
            )}
            {...properties}
        />
    );
}
