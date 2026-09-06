import { useEffect, useRef, useState } from 'react';

import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

/**
 * Reveal only clipped titles, at a constant reading speed. Observing while active keeps sidebar resizing and font
 * loading accurate without installing a ResizeObserver for every idle Session. Cancellation restores ellipsis.
 */
export function useSessionTitleScroll(title: string, isDisabled: boolean) {
    const viewportReference = useRef<HTMLElement>(null);
    const textReference = useRef<HTMLSpanElement>(null);
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const reducedMotion = useShouldReduceMotion();

    useEffect(() => {
        const viewport = viewportReference.current;
        const text = textReference.current;
        if (!viewport || !text || isDisabled || reducedMotion || (!hovered && !focused)) return;
        let animation: Animation | undefined;
        const reset = (): void => {
            animation?.cancel();
            animation = undefined;
            viewport.style.removeProperty('text-overflow');
            text.style.removeProperty('max-width');
        };
        const reveal = (): void => {
            reset();
            const distance = text.scrollWidth - viewport.clientWidth;
            if (distance <= 1) return;
            const travel = (distance / 35) * 1000;
            const duration = 600 + travel + 1200;
            viewport.style.textOverflow = 'clip';
            text.style.maxWidth = 'none';
            animation = text.animate(
                [
                    { transform: 'translateX(0)', offset: 0 },
                    { transform: 'translateX(0)', offset: 600 / duration },
                    { transform: `translateX(-${distance}px)`, offset: (600 + travel) / duration },
                    { transform: `translateX(-${distance}px)`, offset: 1 },
                ],
                { duration, easing: 'linear', fill: 'forwards' },
            );
        };
        const observer = new ResizeObserver(reveal);
        observer.observe(viewport);
        observer.observe(text);
        reveal();
        return () => {
            observer.disconnect();
            reset();
        };
    }, [title, isDisabled, reducedMotion, hovered, focused]);

    return { viewportReference, textReference, setHovered, setFocused };
}
