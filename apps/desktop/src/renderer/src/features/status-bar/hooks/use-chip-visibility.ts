import type { RefObject } from 'react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ChipFit, ChipVisibility, DroppableChip, HiddenChips } from '../chip-priority';
import {
    CHIP_DROP_ORDER,
    chipVisibility,
    isSameHiddenChips,
    NO_HIDDEN_CHIPS,
    resolveHiddenChips,
} from '../chip-priority';

/**
 * The attribute `PriorityChipSlot` sets on the box around each droppable chip.
 */
const PRIORITY_CHIP_ATTRIBUTE = 'data-status-chip';

const DROPPABLE = new Set<string>(CHIP_DROP_ORDER);

/**
 * A computed CSS length such as `8px` as a number, or 0 for `normal` and the like.
 */
function pixels(value: string): number {
    return Number(value.replace(/px$/u, '')) || 0;
}

function columnGap(element: Element): number {
    return pixels(getComputedStyle(element).columnGap);
}

/**
 * Reads one {@link ChipFit} from the rendered footer. Every footer region holds `flex-none` items and never grows, so a
 * region's `scrollWidth` is its content's natural width even while the region itself is squeezed.
 */
function measureChipFit(footer: HTMLElement): ChipFit {
    const style = getComputedStyle(footer);
    const available = footer.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight);
    const regions = [...footer.children];
    let required = columnGap(footer) * Math.max(0, regions.length - 1);
    for (const region of regions) required += region.scrollWidth;
    const rendered: ChipFit['rendered'] = {};
    for (const slot of footer.querySelectorAll<HTMLElement>(
        `[${CSS.escape(PRIORITY_CHIP_ATTRIBUTE)}]`,
    )) {
        const chip = slot.getAttribute(PRIORITY_CHIP_ATTRIBUTE);
        const width = slot.getBoundingClientRect().width;
        if (!chip || !DROPPABLE.has(chip) || width <= 0) continue;
        rendered[chip as DroppableChip] =
            width + (slot.parentElement ? columnGap(slot.parentElement) : 0);
    }
    return { available, required, rendered };
}

/**
 * Which droppable chips the status bar renders, re-resolved whenever the footer resizes or anything inside it changes
 * (a chip appearing, a reading changing width). Starts fully visible so the first frame renders the bar's normal
 * contents before anything has been measured.
 *
 * A hidden chip is unmounted, so the bar cannot tell whether it would still have anything to show. `resetKey` (the
 * selected Session) starts every hidden chip over when it changes: without it, the previous Session's pull request chip
 * keeps its remembered width and goes on hiding memory and usage chips that would fit.
 */
export function useChipVisibility(
    footerReference: RefObject<HTMLElement | null>,
    resetKey: string | undefined,
): ChipVisibility {
    const [hidden, setHidden] = useState<HiddenChips>(NO_HIDDEN_CHIPS);
    const hiddenReference = useRef(hidden);

    useLayoutEffect(() => {
        if (hiddenReference.current.size === 0) return;
        hiddenReference.current = NO_HIDDEN_CHIPS;
        setHidden(NO_HIDDEN_CHIPS);
    }, [resetKey]);

    useLayoutEffect(() => {
        const footer = footerReference.current;
        if (!footer) return;
        const resolve = () => {
            const next = resolveHiddenChips(measureChipFit(footer), hiddenReference.current);
            if (isSameHiddenChips(next, hiddenReference.current)) return;
            hiddenReference.current = next;
            setHidden(next);
        };
        resolve();
        const resizeObserver = new ResizeObserver(resolve);
        resizeObserver.observe(footer);
        // Chips own their data and re-render without the bar, so the bar learns of a new or wider chip from the DOM.
        const mutationObserver = new MutationObserver(resolve);
        mutationObserver.observe(footer, { characterData: true, childList: true, subtree: true });
        return () => {
            resizeObserver.disconnect();
            mutationObserver.disconnect();
        };
    }, [footerReference]);

    return useMemo(() => chipVisibility(hidden), [hidden]);
}
