import { usePointerDragResize } from '../../hooks/use-pointer-drag-resize';
import { PANEL_RESIZE_STEP } from '../../stores/panel-layout';

/**
 * Applied to `document.body` for the duration of a drag; see `styles.css`. Suppresses selection and pointer events
 * globally so the gesture survives crossing an xterm surface or the Monaco editor, neither of which a Tailwind utility
 * on this component could reach.
 */
const DRAG_CLASS = 'panel-resize-active';

/**
 * The seam is invisible at rest — like VS Code's unset `sideBar.border`, the adjacent `bg-surface`/`bg-background` step
 * alone marks the boundary — while a 6px hit column stays comfortable to grab. The column paints `bg-surface` (not
 * transparent): the grid behind it is `bg-background`, which would otherwise show through as a light stripe where both
 * neighbors are surface-colored chrome (Sidebar title beside the tab strip). Hover/focus/drag reveal a centered
 * hairline using a foreground tint, never `--accent` — the divider is chrome, not the one focus indicator (DESIGN.md
 * "One accent focus per screen").
 */
const dividerClassName =
    'panel-divider relative w-1.5 min-w-1.5 bg-surface cursor-col-resize touch-none ' +
    "after:content-[''] after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 " +
    'after:bg-transparent after:pointer-events-none ' +
    'hover:after:w-[3px] hover:after:bg-[color-mix(in_srgb,var(--foreground)_40%,transparent)] ' +
    'data-[dragging=true]:after:w-[3px] data-[dragging=true]:after:bg-[color-mix(in_srgb,var(--foreground)_40%,transparent)] ' +
    'focus-visible:outline-none focus-visible:after:w-[3px] ' +
    'focus-visible:after:bg-[color-mix(in_srgb,var(--foreground)_55%,transparent)] ' +
    'focus-visible:after:shadow-[0_0_0_2px_color-mix(in_srgb,var(--foreground)_25%,transparent)]';

interface PanelDividerProperties {
    ariaLabel: string;
    /**
     * The last committed width; only updated on pointer up, arrow key, or reset — never mid-drag.
     */
    width: number;
    min: number;
    max: number;
    defaultWidth: number;
    /**
     * Custom property this divider drives directly during a drag, bypassing React state.
     */
    cssVariable: '--sidebar-width' | '--inspector-width';
    /**
     * `1` when the panel grows as the pointer moves right (Sidebar), `-1` when it grows as the pointer moves left
     * (Inspector). Also flips the Arrow key mapping so Right always matches the physical drag direction for that
     * divider.
     */
    growDirection: 1 | -1;
    onCommit(width: number): void;
}

/**
 * A min/max-constrained drag divider shared by the Sidebar↔main and main↔Inspector seams. Dragging writes the live
 * width straight to a root CSS custom property (and to `aria-valuenow`) instead of React state, so a mousemove never
 * triggers a render; the width only reaches the panel-layout store — and `localStorage` — once the gesture ends.
 */
export function PanelDivider(properties: PanelDividerProperties) {
    const dragResize = usePointerDragResize({
        value: properties.width,
        min: properties.min,
        max: properties.max,
        resolveValue: (event, start) =>
            start.startValue + (event.clientX - start.startX) * properties.growDirection,
        onDragMove: (next, event) => {
            document.documentElement.style.setProperty(properties.cssVariable, `${next}px`);
            event.currentTarget.setAttribute('aria-valuenow', String(Math.round(next)));
        },
        onCommit: (next, event) => {
            if (event) {
                document.body.classList.remove(DRAG_CLASS);
                delete event.currentTarget.dataset.dragging;
            }
            properties.onCommit(next);
        },
        resolveStep: (event) => {
            const isDecrease = event.key === 'ArrowLeft';
            const isIncrease = event.key === 'ArrowRight';
            if (!isDecrease && !isIncrease) return;
            return PANEL_RESIZE_STEP * properties.growDirection * (isIncrease ? 1 : -1);
        },
        onReset: () => properties.onCommit(properties.defaultWidth),
    });

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
                dragResize.onPointerDown(event);
                document.body.classList.add(DRAG_CLASS);
                event.currentTarget.dataset.dragging = 'true';
            }}
            onPointerMove={dragResize.onPointerMove}
            onPointerUp={dragResize.onPointerUp}
            onPointerCancel={dragResize.onPointerCancel}
            onLostPointerCapture={dragResize.onLostPointerCapture}
            onDoubleClick={() => properties.onCommit(properties.defaultWidth)}
            onKeyDown={dragResize.onKeyDown}
        />
    );
}
