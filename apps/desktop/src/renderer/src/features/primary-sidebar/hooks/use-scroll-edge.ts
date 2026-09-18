import type { RefObject } from 'react';
import { useEffect } from 'react';

/**
 * Publish whether a scroller has left its start edge as `data-scrolled` so CSS can paint a VS Code-style inset shadow
 * without a React re-render. The attribute is a paint signal, not component state.
 */
export function bindScrollEdge(scroller: HTMLElement): () => void {
    const update = (): void => {
        const next = scroller.scrollTop > 0 ? 'true' : 'false';
        if (scroller.dataset.scrolled !== next) scroller.dataset.scrolled = next;
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    return () => scroller.removeEventListener('scroll', update);
}

/**
 * Bind a mounted overflow box so its `data-scrolled` attribute tracks `scrollTop` for the lifetime of the element.
 */
export function useScrollEdge(reference: RefObject<HTMLElement | null>): void {
    useEffect(() => {
        const element = reference.current;
        if (!element) return;
        return bindScrollEdge(element);
    }, [reference]);
}
