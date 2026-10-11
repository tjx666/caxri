import { usePointerDragResize } from '../../hooks/use-pointer-drag-resize';
import { cn } from '../../lib/utilities';
import { PANEL_RESIZE_STEP } from '../../stores/chrome-layout';

/**
 * Applied to `document.body` for the duration of a drag; see `styles.css`. Suppresses selection and pointer events
 * globally so the gesture survives crossing an xterm surface or the Monaco editor, neither of which a Tailwind utility
 * on this component could reach.
 */
const DRAG_CLASS = 'panel-resize-active';

/**
 * The seam is invisible at rest (like VS Code's unset `sideBar.border`), the adjacent `bg-surface`/`bg-background` step
 * alone marks the boundary, while a 6px hit band stays comfortable to grab. The band paints `bg-surface` (not
 * transparent): the grid behind it is `bg-background`, which would otherwise show through as a light stripe where both
 * neighbors are surface-colored chrome (PrimarySidebar title beside the tab strip). Hover/focus/drag reveal a centered
 * hairline using a foreground tint, never `--accent`: the divider is chrome, not the one focus indicator (DESIGN.md
 * "One accent focus per screen").
 */
const dividerClassName =
    'panel-divider relative bg-surface touch-none ' +
    "after:content-[''] after:absolute after:bg-transparent after:pointer-events-none";

/**
 * Axis-specific geometry for the same seam: which side the 6px band is thin on, and which way the revealed hairline
 * stretches. Kept as two whole strings rather than interpolated fragments so Tailwind's scanner sees every class.
 */
const axisClassName = {
    horizontal:
        'h-1.5 min-h-1.5 cursor-row-resize ' +
        'after:inset-x-0 after:top-1/2 after:h-px after:-translate-y-1/2 ' +
        'hover:after:h-[3px] hover:after:bg-[color-mix(in_srgb,var(--foreground)_40%,transparent)] ' +
        'data-[dragging=true]:after:h-[3px] data-[dragging=true]:after:bg-[color-mix(in_srgb,var(--foreground)_40%,transparent)] ' +
        'focus-visible:outline-none focus-visible:after:h-[3px] ' +
        'focus-visible:after:bg-[color-mix(in_srgb,var(--foreground)_55%,transparent)] ' +
        'focus-visible:after:shadow-[0_0_0_2px_color-mix(in_srgb,var(--foreground)_25%,transparent)]',
    vertical:
        'w-1.5 min-w-1.5 cursor-col-resize ' +
        'after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 ' +
        'hover:after:w-[3px] hover:after:bg-[color-mix(in_srgb,var(--foreground)_40%,transparent)] ' +
        'data-[dragging=true]:after:w-[3px] data-[dragging=true]:after:bg-[color-mix(in_srgb,var(--foreground)_40%,transparent)] ' +
        'focus-visible:outline-none focus-visible:after:w-[3px] ' +
        'focus-visible:after:bg-[color-mix(in_srgb,var(--foreground)_55%,transparent)] ' +
        'focus-visible:after:shadow-[0_0_0_2px_color-mix(in_srgb,var(--foreground)_25%,transparent)]',
} as const;

interface PanelDividerProperties {
    ariaLabel: string;
    /**
     * The last committed width (vertical seam) or height (horizontal seam); only updated on pointer up, arrow key, or
     * reset, never mid-drag.
     */
    size: number;
    min: number;
    max: number;
    defaultSize: number;
    /**
     * Custom property this divider drives directly during a drag, bypassing React state.
     */
    cssVariable:
        | '--commander-inbox-width'
        | '--panel-height'
        | '--primary-sidebar-width'
        | '--secondary-sidebar-width';
    /**
     * `1` when the panel grows as the pointer moves right/down (PrimarySidebar), `-1` when it grows as the pointer
     * moves left/up (SecondarySidebar, Panel). Also flips the Arrow key mapping so the "increase" key always matches
     * the physical drag direction for that divider.
     */
    growDirection: 1 | -1;
    /**
     * `'vertical'` for a column seam dragged along X (PrimarySidebar↔main, main↔SecondarySidebar); `'horizontal'` for a
     * row seam dragged along Y (work surface↔Panel). Also selects the Arrow key pair.
     */
    orientation: 'horizontal' | 'vertical';
    onCommit(size: number): void;
}

/**
 * A min/max-constrained drag divider shared by the PrimarySidebar↔main, main↔SecondarySidebar, and work-surface↔Panel
 * seams. Dragging writes the live size straight to a root CSS custom property (and to `aria-valuenow`) instead of React
 * state, so a pointermove never triggers a render; the size only reaches the chrome-layout store, and `localStorage`,
 * once the gesture ends.
 */
export function PanelDivider(properties: PanelDividerProperties) {
    const isHorizontal = properties.orientation === 'horizontal';
    const dragResize = usePointerDragResize({
        value: properties.size,
        min: properties.min,
        max: properties.max,
        resolveValue: (event, start) =>
            start.startValue +
            (isHorizontal ? event.clientY - start.startY : event.clientX - start.startX) *
                properties.growDirection,
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
            const isDecrease = event.key === (isHorizontal ? 'ArrowUp' : 'ArrowLeft');
            const isIncrease = event.key === (isHorizontal ? 'ArrowDown' : 'ArrowRight');
            if (!isDecrease && !isIncrease) return;
            return PANEL_RESIZE_STEP * properties.growDirection * (isIncrease ? 1 : -1);
        },
        onReset: () => properties.onCommit(properties.defaultSize),
    });

    return (
        <div
            role="separator"
            tabIndex={0}
            className={cn(dividerClassName, axisClassName[properties.orientation])}
            /*
             * ARIA orientation describes the separator's own axis, not the axis it is dragged along: the line between
             * two columns runs vertically, and the line between two rows runs horizontally.
             */
            aria-orientation={properties.orientation}
            aria-label={properties.ariaLabel}
            aria-valuemin={properties.min}
            aria-valuemax={properties.max}
            aria-valuenow={Math.round(properties.size)}
            onPointerDown={(event) => {
                dragResize.onPointerDown(event);
                document.body.classList.add(DRAG_CLASS);
                event.currentTarget.dataset.dragging = 'true';
            }}
            onPointerMove={dragResize.onPointerMove}
            onPointerUp={dragResize.onPointerUp}
            onPointerCancel={dragResize.onPointerCancel}
            onLostPointerCapture={dragResize.onLostPointerCapture}
            onDoubleClick={() => properties.onCommit(properties.defaultSize)}
            onKeyDown={dragResize.onKeyDown}
        />
    );
}
