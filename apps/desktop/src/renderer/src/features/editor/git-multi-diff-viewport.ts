import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';

/**
 * Stacked editors grow to their diff's content height so only the outer list scrolls, but a pathological diff (a
 * rewritten lockfile, a generated bundle) is capped here: past the ceiling the editor keeps its own scrollbar, and
 * `alwaysConsumeMouseWheel: false` still hands the wheel back to the outer list at the edges.
 */
export const maxStackedEditorHeight = 4000;
export const initialStackedEditorHeight = 360;

export function useNearMultiDiffViewport(): {
    active: boolean;
    containerRef: RefObject<HTMLElement | null>;
} {
    const containerReference = useRef<HTMLElement | null>(null);
    const [active, setActive] = useState(false);
    useEffect(() => {
        const element = containerReference.current;
        if (!element || typeof IntersectionObserver === 'undefined') {
            setActive(true);
            return;
        }
        const observer = new IntersectionObserver(([entry]) => setActive(entry.isIntersecting), {
            root: element.closest('.git-multi-diff'),
            rootMargin: '720px 0px',
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    return { active, containerRef: containerReference };
}
