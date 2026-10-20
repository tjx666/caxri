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

/**
 * The attribute `StatusItem` sets while it warns, so the bar drops it after the calm chips.
 */
const URGENT_ATTRIBUTE = 'data-status-urgent';

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
 * region's `scrollWidth` is its content's natural width even while the region itself is squeezed. A hidden chip's slot
 * sits off screen to the left, out of the flow, so it adds nothing to that width but still measures its own.
 */
function measureChipFit(footer: HTMLElement): ChipFit {
    const style = getComputedStyle(footer);
    const available = footer.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight);
    const regions = [...footer.children];
    let required = columnGap(footer) * Math.max(0, regions.length - 1);
    for (const region of regions) required += region.scrollWidth;
    const chips: ChipFit['chips'] = {};
    const urgent = new Set<DroppableChip>();
    for (const slot of footer.querySelectorAll<HTMLElement>(
        `[${CSS.escape(PRIORITY_CHIP_ATTRIBUTE)}]`,
    )) {
        const chip = slot.getAttribute(PRIORITY_CHIP_ATTRIBUTE);
        const width = slot.getBoundingClientRect().width;
        if (!chip || !DROPPABLE.has(chip) || width <= 0) continue;
        chips[chip as DroppableChip] =
            width + (slot.parentElement ? columnGap(slot.parentElement) : 0);
        if (slot.querySelector(`[${CSS.escape(URGENT_ATTRIBUTE)}]`))
            urgent.add(chip as DroppableChip);
    }
    return { available, required, chips, urgent };
}

/**
 * Which droppable chips the status bar shows, re-resolved whenever the footer resizes or anything inside it changes (a
 * chip appearing, a reading changing width, a hidden chip's data going away). Starts fully visible so the first frame
 * renders the bar's normal contents before anything has been measured.
 *
 * A hidden chip stays mounted off screen (`PriorityChipSlot`), so the bar always knows its current width: one that
 * loses its data while hidden, or belonged to the previous Session, measures as absent and stops crowding out chips
 * that fit.
 */
export function useChipVisibility(footerReference: RefObject<HTMLElement | null>): ChipVisibility {
    const [hidden, setHidden] = useState<HiddenChips>(NO_HIDDEN_CHIPS);
    const hiddenReference = useRef(hidden);

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
