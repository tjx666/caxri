import type { DragEvent } from 'react';
import { useState } from 'react';

interface SessionMenuDrag {
    /**
     * Index of the row being dragged, for dimming it.
     */
    draggingIndex: number | undefined;
    /**
     * Index the insertion line sits before; `order.length` puts it after the last row.
     */
    dropIndex: number | undefined;
    rowProps: (index: number) => {
        draggable: true;
        onDragStart: (event: DragEvent<HTMLElement>) => void;
        onDragOver: (event: DragEvent<HTMLElement>) => void;
        onDrop: (event: DragEvent<HTMLElement>) => void;
        onDragEnd: () => void;
    };
}

/**
 * Native HTML drag for the Session menu editor's rows. The insertion line goes above or below the hovered row by which
 * half the pointer is in, and the drop reports the move as `onMove(from, to)` with `to` the insertion index.
 */
export function useSessionMenuDrag(onMove: (from: number, to: number) => void): SessionMenuDrag {
    const [draggingIndex, setDraggingIndex] = useState<number>();
    const [dropIndex, setDropIndex] = useState<number>();
    const reset = (): void => {
        setDraggingIndex(undefined);
        setDropIndex(undefined);
    };
    return {
        draggingIndex,
        dropIndex,
        rowProps: (index) => ({
            draggable: true,
            onDragStart: (event) => {
                event.dataTransfer.effectAllowed = 'move';
                setDraggingIndex(index);
            },
            onDragOver: (event) => {
                if (draggingIndex === undefined) return;
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                const isLowerHalf = event.clientY > bounds.top + bounds.height / 2;
                setDropIndex(isLowerHalf ? index + 1 : index);
            },
            onDrop: (event) => {
                event.preventDefault();
                if (draggingIndex !== undefined && dropIndex !== undefined)
                    onMove(draggingIndex, dropIndex);
                reset();
            },
            onDragEnd: reset,
        }),
    };
}
