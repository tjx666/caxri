import type { PointerEvent } from 'react';

import { usePointerDragResize } from '../hooks/use-pointer-drag-resize';

/**
 * Same seam vocabulary as the workbench `PanelDivider`: invisible at rest, a 6px hit band straddling the column border,
 * and a foreground-tinted hairline on hover, focus, and drag. The `color-mix` percentages are that divider's recipe
 * reused verbatim, per the DESIGN.md "State tokens" gap.
 */
const handleClassName =
    'absolute inset-y-0 -right-[3px] z-20 w-1.5 cursor-col-resize touch-none ' +
    "after:content-[''] after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:pointer-events-none " +
    'hover:after:w-[3px] hover:after:bg-[color-mix(in_srgb,var(--foreground)_40%,transparent)] ' +
    'data-[dragging=true]:after:w-[3px] data-[dragging=true]:after:bg-[color-mix(in_srgb,var(--foreground)_40%,transparent)] ' +
    'focus-visible:outline-none focus-visible:after:w-[3px] ' +
    'focus-visible:after:bg-[color-mix(in_srgb,var(--foreground)_55%,transparent)]';

/**
 * Keeps the resize cursor and suppresses text selection on the whole document while a drag is active: without it a
 * horizontal gesture paints a selection across every header label and row it crosses, and the cursor flickers back
 * whenever the pointer outruns the 6px handle. Inline on `body` rather than a stylesheet class because the handle is
 * shared by windows that load different stylesheets (the Workbench and the Process Explorer).
 */
function setDocumentDragging(isDragging: boolean): void {
    document.body.style.cursor = isDragging ? 'col-resize' : '';
    document.body.style.userSelect = isDragging ? 'none' : '';
}

function endDrag(event?: PointerEvent<HTMLElement>): void {
    if (!event) return;
    setDocumentDragging(false);
    delete event.currentTarget.dataset.dragging;
}

/**
 * The draggable right edge of a table column header. The parent header cell must be `relative`. Dragging reports each
 * width through `onDragMove` and the final one through `onCommit`; Arrow keys step it by `step` from the keyboard, and
 * a double-click or Enter calls `onReset`.
 */
export function ColumnResizeHandle({
    label,
    max,
    min,
    step,
    width,
    onCommit,
    onDragMove,
    onReset,
}: {
    label: string;
    max: number;
    min: number;
    step: number;
    /**
     * The column's current width in CSS pixels, where a drag or a keyboard step starts from.
     */
    width: number;
    onCommit: (width: number) => void;
    onDragMove: (width: number, event: PointerEvent<HTMLElement>) => void;
    onReset: () => void;
}) {
    const dragResize = usePointerDragResize({
        value: width,
        min,
        max,
        resolveValue: (event, start) => start.startValue + (event.clientX - start.startX),
        onDragMove: (next, event) => {
            event.currentTarget.setAttribute('aria-valuenow', String(Math.round(next)));
            onDragMove(next, event);
        },
        onCommit: (next, event) => {
            endDrag(event);
            onCommit(next);
        },
        resolveStep: (event) => {
            if (event.key === 'ArrowLeft') return -step;
            if (event.key === 'ArrowRight') return step;
            return;
        },
        onReset,
    });
    return (
        <div
            aria-label={label}
            aria-orientation="vertical"
            aria-valuemax={max}
            aria-valuemin={min}
            aria-valuenow={Math.round(width)}
            className={handleClassName}
            role="separator"
            tabIndex={0}
            onDoubleClick={onReset}
            onKeyDown={dragResize.onKeyDown}
            onLostPointerCapture={dragResize.onLostPointerCapture}
            onPointerCancel={dragResize.onPointerCancel}
            onPointerDown={(event) => {
                dragResize.onPointerDown(event);
                setDocumentDragging(true);
                event.currentTarget.dataset.dragging = 'true';
            }}
            onPointerMove={dragResize.onPointerMove}
            onPointerUp={dragResize.onPointerUp}
        />
    );
}
