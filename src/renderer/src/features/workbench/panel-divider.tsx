import type { KeyboardEvent, PointerEvent } from 'react';
import { useRef } from 'react';

import { PANEL_RESIZE_STEP } from '../../stores/panel-layout';

/**
 * Applied to `document.body` for the duration of a drag; see `styles.css`. Suppresses selection
 * and pointer events globally so the gesture survives crossing an xterm surface or the Monaco
 * editor, neither of which a Tailwind utility on this component could reach.
 */
const DRAG_CLASS = 'panel-resize-active';

/**
 * A hairline sits centered in a wider invisible hit area so a 6px column stays comfortable to
 * grab without widening the visible seam. Hover/focus/drag states use a foreground tint, never
 * `--accent` — the divider is chrome, not the one focus indicator (DESIGN.md "One accent focus
 * per screen").
 */
const dividerClassName =
    'panel-divider relative w-1.5 min-w-1.5 bg-transparent cursor-col-resize touch-none ' +
    "after:content-[''] after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 " +
    'after:bg-border after:pointer-events-none ' +
    'hover:after:w-[3px] hover:after:bg-[color-mix(in_srgb,var(--foreground)_40%,transparent)] ' +
    'data-[dragging=true]:after:w-[3px] data-[dragging=true]:after:bg-[color-mix(in_srgb,var(--foreground)_40%,transparent)] ' +
    'focus-visible:outline-none focus-visible:after:w-[3px] ' +
    'focus-visible:after:bg-[color-mix(in_srgb,var(--foreground)_55%,transparent)] ' +
    'focus-visible:after:shadow-[0_0_0_2px_color-mix(in_srgb,var(--foreground)_25%,transparent)]';

interface PanelDividerProperties {
    ariaLabel: string;
    /**
    The last committed width; only updated on pointer up, arrow key, or reset — never mid-drag.
     */
    width: number;
    min: number;
    max: number;
    defaultWidth: number;
    /**
    Custom property this divider drives directly during a drag, bypassing React state.
     */
    cssVariable: '--sidebar-width' | '--inspector-width';
    /**
     * `1` when the panel grows as the pointer moves right (Sidebar), `-1` when it grows as the
     * pointer moves left (Inspector). Also flips the Arrow key mapping so Right always matches the
     * physical drag direction for that divider.
     */
    growDirection: 1 | -1;
    onCommit(width: number): void;
}

interface DragState {
    pointerId: number;
    startX: number;
    startWidth: number;
}

/**
 * A min/max-constrained drag divider shared by the Sidebar↔main and main↔Inspector seams. Dragging
 * writes the live width straight to a root CSS custom property (and to `aria-valuenow`) instead of
 * React state, so a mousemove never triggers a render; the width only reaches the panel-layout
 * store — and `localStorage` — once the gesture ends.
 */
export function PanelDivider(properties: PanelDividerProperties) {
    const drag = useRef<DragState | null>(null);

    const clamp = (value: number): number =>
        Math.min(properties.max, Math.max(properties.min, value));

    const widthFromPointer = (clientX: number, state: DragState): number =>
        clamp(state.startWidth + (clientX - state.startX) * properties.growDirection);

    const applyLiveWidth = (next: number, element: HTMLElement): void => {
        document.documentElement.style.setProperty(properties.cssVariable, `${next}px`);
        element.setAttribute('aria-valuenow', String(Math.round(next)));
    };

    const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
        const state = drag.current;
        if (!state || state.pointerId !== event.pointerId) return;
        drag.current = null;
        document.body.classList.remove(DRAG_CLASS);
        delete event.currentTarget.dataset.dragging;
        properties.onCommit(widthFromPointer(event.clientX, state));
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.key === 'Enter') {
            event.preventDefault();
            properties.onCommit(properties.defaultWidth);
            return;
        }
        const isDecrease = event.key === 'ArrowLeft';
        const isIncrease = event.key === 'ArrowRight';
        if (!isDecrease && !isIncrease) return;
        event.preventDefault();
        const step = PANEL_RESIZE_STEP * properties.growDirection * (isIncrease ? 1 : -1);
        properties.onCommit(clamp(properties.width + step));
    };

    return (
        <div
            role="separator"
            tabIndex={0}
            className={dividerClassName}
            aria-orientation="vertical"
            aria-label={properties.ariaLabel}
            aria-valuemin={properties.min}
            aria-valuemax={properties.max}
            aria-valuenow={Math.round(properties.width)}
            onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = {
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    startWidth: properties.width,
                };
                document.body.classList.add(DRAG_CLASS);
                event.currentTarget.dataset.dragging = 'true';
            }}
            onPointerMove={(event) => {
                const state = drag.current;
                if (!state || state.pointerId !== event.pointerId) return;
                applyLiveWidth(widthFromPointer(event.clientX, state), event.currentTarget);
            }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={() => properties.onCommit(properties.defaultWidth)}
            onKeyDown={handleKeyDown}
        />
    );
}
