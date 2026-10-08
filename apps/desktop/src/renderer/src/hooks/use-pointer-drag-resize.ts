import type { KeyboardEvent, PointerEvent } from 'react';
import { useRef } from 'react';

import { clamp } from 'es-toolkit';

/**
 * Snapshot captured on pointer down and handed to {@link UsePointerDragResizeOptions.resolveValue} on every subsequent
 * move/up/cancel for the same pointer. `startValue` is `value` at drag start, so a delta-based divider (e.g.
 * PrimarySidebar/SecondarySidebar width, which grows or shrinks from where the drag began) can compute `startValue +
 * delta` instead of re-deriving a position from scratch. A divider that resolves an absolute position instead (e.g. a
 * container-relative split ratio) can ignore it.
 */
interface PointerDragStart {
    pointerId: number;
    startX: number;
    startY: number;
    startValue: number;
}

export interface UsePointerDragResizeOptions {
    /**
     * The last committed value; the origin for keyboard stepping and the drag-start snapshot.
     */
    value: number;
    /**
     * Inclusive lower bound applied to every resolved value before it reaches a callback.
     */
    min: number;
    /**
     * Inclusive upper bound applied to every resolved value before it reaches a callback.
     */
    max: number;
    /**
     * Derives the unclamped candidate value from a pointer event and the snapshot captured at drag start. The hook
     * clamps the result to `[min, max]` (via `clamp` from `es-toolkit`) before it reaches any callback below.
     */
    resolveValue: (event: PointerEvent<HTMLElement>, start: PointerDragStart) => number;
    /**
     * Called on every pointer move while the active pointer is dragging, with the clamped candidate value.
     */
    onDragMove: (value: number, event: PointerEvent<HTMLElement>) => void;
    /**
     * Finalizes a value: on pointer up for the active pointer, on an Arrow-key step, and on pointer cancel/lost-capture
     * when no `onCancel` is supplied. `event` is present only for pointer-driven calls, so DOM cleanup that must not
     * run on a keyboard step (releasing a drag class, clearing a `data-dragging` attribute, …) can guard on its
     * presence.
     */
    onCommit: (value: number, event?: PointerEvent<HTMLElement>) => void;
    /**
     * Called instead of `onCommit` when the active pointer's drag is aborted (pointer cancel or lost capture). Omit to
     * fall back to `onCommit`, so the drag still finalizes at its last position.
     */
    onCancel?: (value: number, event: PointerEvent<HTMLElement>) => void;
    /**
     * Maps a keydown to a signed delta to add to `value`, or `undefined` when the key is not a step key. Lets each
     * divider flip Arrow-key direction to match its physical drag axis.
     */
    resolveStep: (event: KeyboardEvent<HTMLElement>) => number | undefined;
    /**
     * Called for the Enter key. Omit to leave Enter unhandled when the divider has no reset value.
     */
    onReset?: () => void;
}

export interface PointerDragResizeHandlers {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
    onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * Shared imperative mechanics for a pointer-driven resize divider: pointer capture, active-pointerId bookkeeping (so a
 * second, unrelated pointer can never move or end someone else's drag), value resolution with clamping, and Arrow-key
 * stepping. The caller owns everything about _how_ a value is applied (CSS custom property vs React state,
 * drag-affordance classes, aria attributes) via `resolveValue`/`onDragMove`/`onCommit`/`onCancel`; spread the returned
 * handlers onto the divider element.
 */
export function usePointerDragResize(
    options: UsePointerDragResizeOptions,
): PointerDragResizeHandlers {
    const drag = useRef<PointerDragStart | null>(null);

    const clampToRange = (raw: number): number => clamp(raw, options.min, options.max);

    const endDrag = (
        event: PointerEvent<HTMLElement>,
        onEnd: (value: number, event: PointerEvent<HTMLElement>) => void,
    ): void => {
        const start = drag.current;
        if (!start || start.pointerId !== event.pointerId) return;
        drag.current = null;
        onEnd(clampToRange(options.resolveValue(event, start)), event);
    };

    return {
        onPointerDown: (event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                startValue: options.value,
            };
        },
        onPointerMove: (event) => {
            const start = drag.current;
            if (!start || start.pointerId !== event.pointerId) return;
            options.onDragMove(clampToRange(options.resolveValue(event, start)), event);
        },
        onPointerUp: (event) => endDrag(event, options.onCommit),
        onPointerCancel: (event) => endDrag(event, options.onCancel ?? options.onCommit),
        onLostPointerCapture: (event) => endDrag(event, options.onCancel ?? options.onCommit),
        onKeyDown: (event) => {
            if (event.key === 'Enter') {
                if (!options.onReset) return;
                event.preventDefault();
                options.onReset();
                return;
            }
            const delta = options.resolveStep(event);
            if (delta === undefined) return;
            event.preventDefault();
            options.onCommit(clampToRange(options.value + delta));
        },
    };
}
