import type { RefObject } from 'react';
import { useLayoutEffect, useRef } from 'react';

import { useShouldReduceMotion } from '../../../hooks/use-should-reduce-motion';
import { motionDurationMs, motionEasing } from '../../../lib/motion';
import { glideBoxIn, selectionGlideKeyframes } from '../session-selection-glide';

const SELECTED_CARD = '.session-card.active';

/**
 * Glides the sidebar's selection fill from the row that lost the selection to the row that gained it, on the chrome tab
 * indicator's `--motion-chrome-switch`, while the Session itself switches instantly (DESIGN.md "Motion").
 *
 * The selected row keeps painting its own fill; the glide only borrows it for one run. For the run, `ghost` (an
 * absolutely positioned fill under the rows) is laid out on the new row and animated in from the old one, and the new
 * row's own fill is cleared so the two never overlap. Measuring both rows when the selection changes, rather than
 * tracking the fill continuously, keeps scrolling, disclosures, renames, and resizes out of it: the fill a row paints
 * is always where the row is.
 */
export function useSessionSelectionGlide(
    list: RefObject<HTMLElement | null>,
    ghost: RefObject<HTMLElement | null>,
    selectedSessionId: string | undefined,
): void {
    const shouldReduceMotion = useShouldReduceMotion();
    const previousCard = useRef<HTMLElement | null>(null);
    const running = useRef<Animation | null>(null);
    useLayoutEffect(() => {
        const listElement = list.current;
        const ghostElement = ghost.current;
        const card = listElement?.querySelector<HTMLElement>(SELECTED_CARD) ?? null;
        const previous = previousCard.current;
        previousCard.current = card;
        if (!listElement || !ghostElement || !card) return;
        // Restart from where the fill is on screen when a glide is still running, not from the row it left.
        const interrupted = running.current;
        running.current = null;
        const source = interrupted ? ghostElement : previous;
        const from = source?.isConnected ? glideBoxIn(listElement, source) : undefined;
        interrupted?.cancel();
        if (shouldReduceMotion || !previous || previous === card || !from || from.height === 0) {
            ghostElement.style.setProperty('display', 'none');
            return;
        }
        const to = glideBoxIn(listElement, card);
        Object.assign(ghostElement.style, {
            display: 'block',
            height: `${to.height}px`,
            left: `${to.left}px`,
            top: `${to.top}px`,
            width: `${to.width}px`,
        });
        card.style.backgroundColor = 'transparent';
        const animation = ghostElement.animate(selectionGlideKeyframes(from, to), {
            duration: motionDurationMs('--motion-chrome-switch'),
            // Web Animations take no `var()`, so the token resolves to its control points first.
            easing: `cubic-bezier(${motionEasing('--motion-ease-emphasized').join(', ')})`,
        });
        running.current = animation;
        const settle = (): void => {
            card.style.removeProperty('background-color');
            running.current = null;
            ghostElement.style.setProperty('display', 'none');
        };
        animation.addEventListener('finish', settle);
        /**
         * The next selection (or unmount) hands this row's fill back but leaves the ghost running, so the next run can
         * restart from where it is on screen before cancelling it.
         */
        return () => {
            animation.removeEventListener('finish', settle);
            card.style.removeProperty('background-color');
        };
    }, [ghost, list, selectedSessionId, shouldReduceMotion]);
}
