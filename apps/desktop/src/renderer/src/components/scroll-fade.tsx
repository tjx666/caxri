import type { ComponentProps, ReactNode, RefObject } from 'react';
import { useRef } from 'react';

import { useScrollEdges } from '../hooks/use-scroll-edges';
import { cn } from '../lib/utilities';

/**
 * Which fill the scroll cue has to blend into. A pane tab bar names them in its own precedence order: the drop-target
 * tint covers everything, then the Workbench bar's title-bar fill, then an ordinary surface (also a report card's).
 */
export type ScrollFadeFill = 'dropTarget' | 'surface' | 'titleBar';

const SCROLL_FADE_FILL_CLASS_NAME: Record<ScrollFadeFill, string> = {
    dropTarget: 'from-elevated',
    surface: 'from-surface',
    // Tracks the root bar's own two states, so the cue stays seamless when the window loses focus.
    titleBar: 'from-title-bar-active-background window-inactive:from-title-bar-inactive-background',
};

/**
 * The gradient cue for one end of a horizontal scroller. Render it only on an edge that actually hides content; it
 * fades to the background the scroller sits on so the cue never draws a visible seam against it. `motion-safe:` keeps
 * the appear/disappear crossfade off entirely under reduced motion (DESIGN.md's motion layer contract), leaving an
 * instant show/hide. Its parent must be the positioned box that frames the scroller.
 */
export function ScrollFade({ edge, fill }: { edge: 'end' | 'start'; fill: ScrollFadeFill }) {
    return (
        <div
            aria-hidden="true"
            className={cn(
                'pointer-events-none absolute inset-y-0 z-[4] w-6 to-transparent motion-safe:transition-opacity',
                edge === 'start' ? 'left-0 bg-gradient-to-r' : 'right-0 bg-gradient-to-l',
                SCROLL_FADE_FILL_CLASS_NAME[fill],
            )}
        />
    );
}

/**
 * A sideways scroller that shows a `ScrollFade` on whichever edge hides content, for wide content (a report table, a
 * year-long chart) inside a pane that can be narrower than it.
 *
 * The cue cannot be left to the native scrollbar: macOS overlay scrollbars (System Settings "Show scroll bars: When
 * scrolling", or "Automatically" with a trackpad) stay hidden at rest, and the shared 8px rail in `scrollbars.css` is
 * inert by default (see the note there). Without a cue, a cut-off column reads as the whole table.
 *
 * Two cues, because either alone can miss: the fade dissolves whatever content meets the hidden edge, but a table cut
 * between two columns has nothing there to dissolve. So this scroller also resets `scrollbar-width`/`scrollbar-color`
 * to `auto`, which lets Chromium apply the shared `::-webkit-scrollbar` 8px rail; a styled WebKit scrollbar is a
 * classic one, visible at rest whenever the content overflows, and its thumb shows how much is hidden and where. The
 * reset is `!important` because the global `*` rule is unlayered CSS, which beats any Tailwind utility layer.
 *
 * The edge sentinels sit absolutely at both ends of a `w-fit min-w-full` content box, so the content keeps its own
 * layout (a block table, a flex chart) and the box is exactly as wide as what scrolls. The scroller also publishes
 * `data-horizontal-scroll` and `data-scroll-fade-start`/`data-scroll-fade-end`, which E2E reads instead of pixels.
 */
export function HorizontalScrollArea({
    children,
    className,
    fill = 'surface',
    scrollClassName,
    scrollReference,
    ...scrollProperties
}: Omit<ComponentProps<'div'>, 'ref'> & {
    children: ReactNode;
    /**
     * Classes for the positioned frame around the scroller, e.g. its outer margin.
     */
    className?: string;
    fill?: ScrollFadeFill;
    /**
     * Classes for the scrolling element itself, e.g. its focus outline.
     */
    scrollClassName?: string;
    /**
     * The scrolling element, for a caller that also drives it (the Activity chart pins itself to the newest weeks).
     */
    scrollReference?: RefObject<HTMLDivElement | null>;
}) {
    const ownScrollReference = useRef<HTMLDivElement>(null);
    const scroller = scrollReference ?? ownScrollReference;
    const startSentinel = useRef<HTMLSpanElement>(null);
    const endSentinel = useRef<HTMLSpanElement>(null);
    const { canScrollEnd, canScrollStart } = useScrollEdges(scroller, startSentinel, endSentinel);
    return (
        <div className={cn('relative min-w-0', className)}>
            <div
                {...scrollProperties}
                ref={scroller}
                className={cn(
                    '[scrollbar-width:auto]! [scrollbar-color:auto]! overflow-x-auto',
                    scrollClassName,
                )}
                data-horizontal-scroll=""
                data-scroll-fade-start={canScrollStart || undefined}
                data-scroll-fade-end={canScrollEnd || undefined}
            >
                <div className="relative w-fit min-w-full">
                    <span
                        ref={startSentinel}
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-y-0 left-0 w-px"
                    />
                    {children}
                    <span
                        ref={endSentinel}
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-y-0 right-0 w-px"
                    />
                </div>
            </div>
            {canScrollStart && <ScrollFade edge="start" fill={fill} />}
            {canScrollEnd && <ScrollFade edge="end" fill={fill} />}
        </div>
    );
}
