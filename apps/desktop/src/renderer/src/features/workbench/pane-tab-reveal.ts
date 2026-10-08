import type { RefObject } from 'react';
import { useEffect } from 'react';

/**
 * Sub-pixel slack. Layout rounding routinely leaves a fraction of a pixel between a fully visible tab and its rail
 * edge; treating that as overflow would write `scrollLeft` on every `ResizeObserver` callback, and writing it feeds the
 * next callback.
 */
const REVEAL_EPSILON = 0.5;

/**
 * One tab measured against its scrolling rail, in viewport coordinates, plus the rail's current `scrollLeft`. Viewport
 * rects rather than `offsetLeft` because the tab's offset parent is the inner flex list, not the scroll container.
 */
export interface TabRevealGeometry {
    railEnd: number;
    railStart: number;
    scrollLeft: number;
    tabEnd: number;
    tabStart: number;
}

/**
 * The `scrollLeft` that brings the active tab fully into view, or `undefined` when it already is.
 *
 * Minimal scroll, never centering: a tab hidden on the right is brought just far enough that its trailing edge meets
 * the rail's, and one hidden on the left is aligned to the rail's leading edge. This mirrors VS Code's
 * `doLayoutTabsNonWrapping` (`src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts`), which also aligns a
 * tab wider than the rail to its start so the filename stays readable instead of scrolling to its tail.
 */
export function planTabReveal(geometry: TabRevealGeometry): number | undefined {
    const railWidth = geometry.railEnd - geometry.railStart;
    const tabWidth = geometry.tabEnd - geometry.tabStart;
    if (railWidth <= 0 || tabWidth <= 0) return undefined;
    const overflowStart = geometry.tabStart - geometry.railStart;
    if (tabWidth >= railWidth) {
        return Math.abs(overflowStart) <= REVEAL_EPSILON
            ? undefined
            : geometry.scrollLeft + overflowStart;
    }
    if (overflowStart < -REVEAL_EPSILON) return geometry.scrollLeft + overflowStart;
    const overflowEnd = geometry.tabEnd - geometry.railEnd;
    if (overflowEnd > REVEAL_EPSILON) return geometry.scrollLeft + overflowEnd;
    return undefined;
}

/**
 * Keeps the active tab inside its rail. `overflow-x-auto` has no cue of its own for "the active tab is off to the
 * side," so selecting or creating a tab that lands outside the visible bar must scroll itself into view.
 *
 * The reveal cannot be a one-shot effect on `activeTabId`, because two things happen after that effect would run:
 *
 * 1. A freshly mounted tab enters from `maxWidth: 0` (see `useWorkTabMotion` in `../tabs/work-tab.tsx`), so measuring it
 *    in the commit that created it yields a near-zero scroll delta, and the animation then widens it right back out of
 *    view. Reduced motion collapses that window to nothing but does not change the shape of the problem.
 * 2. A preview tab keeps its id when it is handed a different file (`replaced.id` reuse in `pane-layout-reducer.ts`), so a
 *    longer filename can widen the active tab without `activeTabId` ever changing.
 *
 * Observing the active tab's box covers both: the reveal re-runs for as long as its width is still settling.
 *
 * @param listReference The tablist holding both segments; either one can be the rail that overflows.
 * @param activeTabId Re-runs the effect when selection moves to a different tab.
 * @param isSuppressed Skips the reveal while a drag is rearranging the bar, so the pointer is not fought for control of
 *   the scroll position.
 */
export function useActiveTabReveal(
    listReference: RefObject<HTMLDivElement | null>,
    activeTabId: string | undefined,
    isSuppressed: boolean,
): void {
    useEffect(() => {
        const list = listReference.current;
        if (!list || isSuppressed) return;
        const tab = list.querySelector<HTMLElement>('[data-tab-active="true"]');
        const rail = tab?.closest<HTMLElement>('[data-tab-scroll-rail]');
        if (!tab || !rail) return;
        const reveal = (): void => {
            const railRect = rail.getBoundingClientRect();
            const tabRect = tab.getBoundingClientRect();
            const next = planTabReveal({
                railEnd: railRect.right,
                railStart: railRect.left,
                scrollLeft: rail.scrollLeft,
                tabEnd: tabRect.right,
                tabStart: tabRect.left,
            });
            if (next !== undefined) rail.scrollLeft = next;
        };
        reveal();
        const observer = new ResizeObserver(reveal);
        observer.observe(tab);
        observer.observe(rail);
        return () => observer.disconnect();
    }, [activeTabId, isSuppressed, listReference]);
}
