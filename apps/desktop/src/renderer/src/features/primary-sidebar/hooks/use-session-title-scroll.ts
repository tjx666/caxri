import { useEffect, useRef, useState } from 'react';

import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { sessionTitleScrollTimeline } from '../session-title-scroll';

/**
 * Reveal only clipped titles, at a constant reading speed. Observing while active keeps sidebar resizing and font
 * loading accurate without installing a ResizeObserver for every idle Session. While the text slides, the fade host's
 * edge widths animate with it: the left edge fades in over the first fade-width of travel and the right edge clears
 * over the last, so text dissolves at both edges the way Codex's sidebar does instead of the mask switching off.
 * Cancellation restores the resting right-edge fade.
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
        const fadeHost = viewport.closest<HTMLElement>('.overflow-fade');
        let animations: Animation[] = [];
        const reset = (): void => {
            for (const animation of animations) animation.cancel();
            animations = [];
            text.style.removeProperty('max-width');
        };
        const reveal = (): void => {
            reset();
            const distance = text.scrollWidth - viewport.clientWidth;
            if (distance <= 1) return;
            const fade = fadeHost
                ? getComputedStyle(fadeHost).getPropertyValue('--overflow-fade-end').trim() || '0px'
                : '0px';
            const { duration, slideStart, fadeIn, fadeOut, slideEnd } = sessionTitleScrollTimeline(
                distance,
                Number(fade.replace('px', '')) || 0,
            );
            const timing: KeyframeAnimationOptions = {
                duration,
                easing: 'linear',
                fill: 'forwards',
            };
            text.style.maxWidth = 'none';
            animations.push(
                text.animate(
                    [
                        { transform: 'translateX(0)', offset: 0 },
                        { transform: 'translateX(0)', offset: slideStart },
                        {
                            transform: `translateX(-${distance}px)`,
                            offset: slideEnd,
                        },
                        { transform: `translateX(-${distance}px)`, offset: 1 },
                    ],
                    timing,
                ),
            );
            if (!fadeHost) return;
            const edges = (start: string, end: string, offset: number): Keyframe => ({
                '--overflow-fade-start': start,
                '--overflow-fade-end': end,
                offset,
            });
            const keyframes = [
                edges('0px', fade, 0),
                edges('0px', fade, slideStart),
                edges(fade, fade, fadeIn),
                edges(fade, fade, fadeOut),
                edges(fade, '0px', slideEnd),
                edges(fade, '0px', 1),
            ];
            animations.push(fadeHost.animate(keyframes, timing));
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

export type SessionTitleScroll = ReturnType<typeof useSessionTitleScroll>;
