import type { RefObject } from 'react';
import { useEffect } from 'react';

/**
 * Focuses `reference.current` whenever `revision` changes to a truthy value, following the "bump a revision counter to
 * request focus" contract shared across features: a caller increments an integer state to signal "focus this element
 * now" without needing to reach into the DOM itself.
 *
 * Focus is scheduled through `requestAnimationFrame` (cancelled on cleanup) to avoid races with the element mounting or
 * becoming enabled in the same render pass.
 */
export function useFocusOnRevision(
    revision: number | undefined,
    reference: RefObject<HTMLElement | null>,
    options?: { select?: boolean; scrollIntoView?: boolean },
): void {
    const isSelect = options?.select ?? false;
    const isScrollIntoView = options?.scrollIntoView ?? false;

    useEffect(() => {
        if (!revision) return;

        const frame = requestAnimationFrame(() => {
            const element = reference.current;
            if (!element) return;

            element.focus();
            if (
                isSelect &&
                (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
            )
                element.select();
            if (isScrollIntoView) element.scrollIntoView({ block: 'center' });
        });

        return () => cancelAnimationFrame(frame);
    }, [revision, reference, isSelect, isScrollIntoView]);
}
