import type { ReactNode } from 'react';

import { openExternalUrl } from '../../lib/external-link';
import { cn } from '../../lib/utilities';
import { pushToast } from '../../stores/toasts';
import type { DroppableChip } from './chip-priority';
import { StatusTooltip } from './status-tooltip';

/**
 * The glyph is sized here rather than by each caller's `size` prop, so that `icon` can take any rendered element: a
 * Lucide component, a Linear workflow glyph, without every call site having to know which of the two status-bar heights
 * it is rendering into. CSS wins over an SVG's `width`/`height` attributes, and neither icon family scales its
 * `viewBox` with `size`, so the result is identical to the prop. 13px is the `base` type tier this item sits at;
 * DESIGN.md "Spacing and radius" records why the two bar glyph boxes are allowed to state it. Figures are tabular, as
 * on `StatusInfo`, so a value that changes on every poll (`9 tok/s` to `10 tok/s`) does not nudge its neighbours.
 */
export const statusItemClassName =
    'statusbar-item inline-flex h-5 min-w-0 items-center gap-[5px] overflow-hidden rounded border-0 bg-transparent px-[5px] text-foreground tabular-nums no-underline cursor-pointer hover:bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--foreground)] [&>svg]:flex-none [&>svg]:size-[13px] [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap';

/**
 * The box `useChipVisibility` measures around a chip it may drop (see `chip-priority.ts`). It collapses while the chip
 * renders nothing (`empty:hidden`), so an absent chip takes no flex gap and measures as absent.
 *
 * A hidden chip keeps rendering, invisible and inert, in a `fixed` box off the left edge of the window: out of the
 * bar's flow and its scrollable width, but still laid out at its natural width. That keeps its current width
 * measurable, so a hidden chip whose data goes away stops holding room the visible chips could use.
 */
export function PriorityChipSlot({
    chip,
    children,
    isHidden,
}: {
    chip: DroppableChip;
    children: ReactNode;
    isHidden: boolean;
}) {
    return (
        <span
            aria-hidden={isHidden || undefined}
            className={cn(
                'flex flex-none items-center empty:hidden',
                isHidden && 'pointer-events-none invisible fixed top-0 right-full',
            )}
            data-status-chip={chip}
            data-status-chip-hidden={isHidden || undefined}
            inert={isHidden}
        >
            {children}
        </span>
    );
}

/**
 * Same hover-tooltip contract as `StatusInfo`, for the clickable status-bar entries. `flex-none`: a status-bar item
 * keeps its whole label, and the bar drops whole chips by priority instead (DESIGN.md status bar redline). Omit
 * `children` for a standing mode in its normal state: DESIGN.md keeps those icon-only, with the words on `ariaLabel`
 * and `title`.
 */
export function StatusItem({
    ariaLabel,
    children,
    className,
    href,
    icon,
    interactiveTitle,
    onClick,
    title,
}: {
    ariaLabel: string;
    /**
     * Visible text after the glyph. Omitted for an icon-only item, which then renders no text span at all.
     */
    children?: ReactNode;
    className?: string;
    href?: string;
    icon: ReactNode;
    /**
     * Renders `title` in a hover card the pointer can enter, for a title that carries its own links.
     */
    interactiveTitle?: boolean;
    onClick?: () => void;
    title: ReactNode;
}) {
    const content = (
        <>
            {icon}
            {children === undefined ? null : <span>{children}</span>}
        </>
    );
    return (
        <StatusTooltip content={title} interactive={interactiveTitle}>
            {href ? (
                <a
                    className={cn(statusItemClassName, 'flex-none', className)}
                    href={href}
                    rel="noreferrer"
                    aria-label={ariaLabel}
                    onClick={(event) => {
                        // Main denies every `window.open`/target=_blank navigation, so this anchor
                        // is semantic only; the actual navigation goes through `external.open`.
                        event.preventDefault();
                        // eslint-disable-next-line no-void -- intentional floating-promise discard, openExternalUrl reports its own failure
                        void openExternalUrl(href, (message) => pushToast('error', message));
                    }}
                >
                    {content}
                </a>
            ) : (
                <button
                    type="button"
                    className={cn(statusItemClassName, 'flex-none', className)}
                    aria-label={ariaLabel}
                    onClick={onClick}
                >
                    {content}
                </button>
            )}
        </StatusTooltip>
    );
}
