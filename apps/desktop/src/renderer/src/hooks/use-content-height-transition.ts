import type { RefObject } from 'react';
import { useLayoutEffect, useRef } from 'react';

/**
 * The motion token a height change runs on: growing expands, shrinking collapses, as `DESIGN.md`'s disclosures do.
 */
export function contentHeightTransitionToken(from: number, to: number): string {
    return to > from ? '--motion-expand' : '--motion-collapse';
}

/**
 * Makes an outer element's height follow its content's with a CSS transition instead of jumping: the Agent Chat
 * composer grows smoothly when the first attachment arrives and shrinks when the last one leaves. The outer element
 * needs `overflow-hidden` and `transition-[height]`. The content is measured with a `ResizeObserver`, which runs after
 * layout and before paint, so content that just grew is clipped by the outer element's old height for that frame rather
 * than shown at full size first. The first measurement applies without a transition, so content already present on
 * mount (a restored draft's attachments) does not animate open.
 */
export function useContentHeightTransition<
    Outer extends HTMLElement,
    Inner extends HTMLElement,
>(): readonly [RefObject<Outer | null>, RefObject<Inner | null>] {
    const outerReference = useRef<Outer>(null);
    const innerReference = useRef<Inner>(null);
    useLayoutEffect(() => {
        const outer = outerReference.current;
        const inner = innerReference.current;
        if (!outer || !inner) return;
        let height = inner.offsetHeight;
        outer.style.height = `${height}px`;
        const observer = new ResizeObserver(() => {
            const next = inner.offsetHeight;
            if (next === height) return;
            const token = contentHeightTransitionToken(height, next);
            outer.style.transitionDuration = `var(${token})`;
            outer.style.transitionTimingFunction =
                token === '--motion-expand'
                    ? 'var(--motion-ease-emphasized)'
                    : 'var(--motion-ease-exit)';
            outer.style.height = `${next}px`;
            height = next;
        });
        observer.observe(inner);
        return () => observer.disconnect();
    }, []);
    return [outerReference, innerReference] as const;
}
