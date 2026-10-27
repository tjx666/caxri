import type { RefObject } from 'react';
import { useEffect } from 'react';

/**
 * Publish which edges of a scroller hide content so CSS can paint a VS Code-style inset shadow on each without a React
 * re-render: `data-scrolled` once it has left its start edge, and `data-more-below` while rows remain past its end. The
 * attributes are paint signals, not component state.
 *
 * The end edge also moves without a scroll event, when rows are added, revealed, or collapsed, or the scroller resizes,
 * so the scroller and its direct children are watched for size changes as well.
 */
export function bindScrollEdge(scroller: HTMLElement): () => void {
    const update = (): void => {
        const scrolled = scroller.scrollTop > 0 ? 'true' : 'false';
        if (scroller.dataset.scrolled !== scrolled) scroller.dataset.scrolled = scrolled;
        // A 1px allowance: fractional zoom can leave scrollTop a subpixel short of the end.
        const moreBelow =
            scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1
                ? 'true'
                : 'false';
        if (scroller.dataset.moreBelow !== moreBelow) scroller.dataset.moreBelow = moreBelow;
    };
    update();
    // An IntersectionObserver would need a sentinel after the last row of every bound scroller; these are five shared
    // trees whose content the hook does not own. Reading scroll metrics in a passive scroll listener forces no layout.
    // eslint-disable-next-line unicorn/prefer-observer-apis -- see above
    scroller.addEventListener('scroll', update, { passive: true });
    const resizes = new ResizeObserver(update);
    const observeChildren = (): void => {
        resizes.disconnect();
        resizes.observe(scroller);
        for (const child of scroller.children) resizes.observe(child);
    };
    observeChildren();
    const children = new MutationObserver(() => {
        observeChildren();
        update();
    });
    children.observe(scroller, { childList: true });
    return () => {
        scroller.removeEventListener('scroll', update);
        resizes.disconnect();
        children.disconnect();
    };
}

/**
 * Bind a mounted overflow box so its `data-scrolled` and `data-more-below` attributes track its scroll position for the
 * lifetime of the element.
 */
export function useScrollEdge(reference: RefObject<HTMLElement | null>): void {
    useEffect(() => {
        const element = reference.current;
        if (!element) return;
        return bindScrollEdge(element);
    }, [reference]);
}
