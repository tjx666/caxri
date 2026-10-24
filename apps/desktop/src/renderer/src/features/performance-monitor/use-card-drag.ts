import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { clampOverlayPosition } from './format';
import type { OverlayPosition } from './monitor-store';

/**
 * Writes the drag transform straight to the element so a drag never re-renders React.
 */
function moveCard(card: HTMLElement, position: OverlayPosition): void {
    card.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
}

function fitToViewport(card: HTMLElement | null, candidate: OverlayPosition): OverlayPosition {
    if (!card) return candidate;
    const rect = card.getBoundingClientRect();
    return clampOverlayPosition(
        candidate,
        { height: rect.height, width: rect.width },
        { height: innerHeight, width: innerWidth },
    );
}

const EDGE_MARGIN_PX = 16;
const STATUS_BAR_CLEARANCE_PX = 40;

/**
 * Drag behaviour for a fixed card. While the pointer is down the card moves by writing `transform` straight to its
 * element, so a drag never re-renders React or triggers layout; the final position is committed once on release (where
 * the caller persists it). The position is clamped into the viewport on release and whenever the window resizes, so a
 * smaller window or a different zoom can never strand the card off screen.
 */
export function useCardDrag(
    cardReference: RefObject<HTMLElement | null>,
    saved: OverlayPosition | null,
    commit: (position: OverlayPosition) => void,
): {
    handleProperties: {
        onPointerCancel: (event: ReactPointerEvent) => void;
        onPointerDown: (event: ReactPointerEvent) => void;
        onPointerMove: (event: ReactPointerEvent) => void;
        onPointerUp: (event: ReactPointerEvent) => void;
    };
    position: OverlayPosition;
} {
    const [position, setPosition] = useState<OverlayPosition>(saved ?? { x: 0, y: 0 });
    const drag = useRef<
        { originX: number; originY: number; pointerId: number; x: number; y: number } | undefined
    >(undefined);
    const live = useRef(position);
    const hasSaved = saved !== null;

    // First paint: rest in the bottom-right corner, above the status bar, unless a position was saved.
    useLayoutEffect(() => {
        const card = cardReference.current;
        if (!card) return;
        const rect = card.getBoundingClientRect();
        const initial = hasSaved
            ? live.current
            : {
                  x: innerWidth - rect.width - EDGE_MARGIN_PX,
                  y: innerHeight - rect.height - STATUS_BAR_CLEARANCE_PX,
              };
        const fitted = fitToViewport(cardReference.current, initial);
        live.current = fitted;
        setPosition(fitted);
    }, [cardReference, hasSaved]);

    useEffect(() => {
        const refit = (): void => {
            const fitted = fitToViewport(cardReference.current, live.current);
            if (fitted.x === live.current.x && fitted.y === live.current.y) return;
            live.current = fitted;
            setPosition(fitted);
        };
        addEventListener('resize', refit);
        // The readout grows after first paint (process rows arrive), so a card resting at the bottom edge must be
        // pulled back inside whenever its own size changes, not only when the window does.
        const observer = new ResizeObserver(refit);
        if (cardReference.current) observer.observe(cardReference.current);
        return () => {
            removeEventListener('resize', refit);
            observer.disconnect();
        };
    }, [cardReference]);

    const finish = (event: ReactPointerEvent): void => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        drag.current = undefined;
        event.currentTarget.releasePointerCapture(event.pointerId);
        const fitted = fitToViewport(cardReference.current, { x: active.x, y: active.y });
        live.current = fitted;
        setPosition(fitted);
        commit(fitted);
    };

    return {
        position,
        handleProperties: {
            onPointerDown: (event) => {
                if (event.button !== 0) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = {
                    originX: event.clientX - live.current.x,
                    originY: event.clientY - live.current.y,
                    pointerId: event.pointerId,
                    x: live.current.x,
                    y: live.current.y,
                };
            },
            onPointerMove: (event) => {
                const active = drag.current;
                const card = cardReference.current;
                if (!card || !active || active.pointerId !== event.pointerId) return;
                const next = fitToViewport(cardReference.current, {
                    x: event.clientX - active.originX,
                    y: event.clientY - active.originY,
                });
                active.x = next.x;
                active.y = next.y;
                moveCard(card, next);
            },
            onPointerUp: finish,
            onPointerCancel: finish,
        },
    };
}
