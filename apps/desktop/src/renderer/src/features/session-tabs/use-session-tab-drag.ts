import type { DragEvent, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';

import { getOpenSessionIds } from '../../stores/open-sessions';
import { resolveTabDropIndex } from '../workbench/pane-drop-zone';
import { reorderSessionTab, tearOffSessionTab } from './session-tab-commands';
import { SESSION_TAB_DRAG_TYPE, shouldTearOffSessionTab } from './session-tabs-state';

function canAcceptDrop(event: DragEvent<HTMLElement>): boolean {
    return event.dataTransfer.types.includes(SESSION_TAB_DRAG_TYPE);
}

function sessionTabIdAt(target: EventTarget | null): string | undefined {
    return target instanceof Element
        ? (target.closest<HTMLElement>('[data-session-tab-id]')?.dataset.sessionTabId ?? undefined)
        : undefined;
}

/**
 * Where a drop at `clientX` lands, measured against every tab but the dragged one, which is how `resolveTabDropIndex`
 * and `moveOpenSession` agree on what the index means.
 */
function dropGeometry(
    list: HTMLElement,
    draggedId: string | undefined,
    clientX: number,
): { edgeX: number; index: number | undefined } | undefined {
    const rects: DOMRect[] = [];
    for (const element of list.querySelectorAll<HTMLElement>('[data-session-tab-id]')) {
        if (element.dataset.sessionTabId !== draggedId) rects.push(element.getBoundingClientRect());
    }
    if (rects.length === 0) return undefined;
    const index = resolveTabDropIndex(rects, clientX);
    const target = index === undefined ? rects.at(-1) : rects[index];
    if (!target) return undefined;
    return { edgeX: index === undefined ? target.right : target.left, index };
}

/**
 * Drag-to-reorder for the Open Session strip: the insertion line and the drop. Reuses `resolveTabDropIndex`, the same
 * pure geometry the pane tab bar resolves its drops with, but never touches pane state: a Session tab can only be moved
 * inside the strip, and its own drag type keeps pane bars and sidebar rows from reacting to it.
 *
 * `listReference` is the non-scrolling `tablist`, so the insertion line shares a coordinate space with the tabs it
 * points between however far the rail underneath has scrolled.
 */
export function useSessionTabDrag(listReference: RefObject<HTMLDivElement | null>): {
    dropIndicatorLeft: number | undefined;
    onDragEnd: (event: DragEvent<HTMLDivElement>) => void;
    onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
    onDragOver: (event: DragEvent<HTMLDivElement>) => void;
    onDragStart: (event: DragEvent<HTMLDivElement>) => void;
    onDrop: (event: DragEvent<HTMLDivElement>) => void;
} {
    const [dropIndicatorLeft, setDropIndicatorLeft] = useState<number | undefined>(undefined);
    /**
     * `dataTransfer.getData` is unreadable during `dragover`, so the dragged id is captured at `dragstart`.
     */
    const draggedIdReference = useRef<string | undefined>(undefined);
    /**
     * Whether this drag already landed on the strip. `dropEffect` alone is not trusted to say so: Chromium only honors
     * a `dropEffect` written during `dragover`, so a drag whose drop the strip handled can still end with `none`
     * (always, for synthetic events), and treating that as "released outside" would tear off the tab the user just
     * reordered.
     */
    const droppedReference = useRef(false);
    useEffect(() => {
        const clear = (): void => {
            setDropIndicatorLeft(undefined);
            draggedIdReference.current = undefined;
        };
        addEventListener('dragend', clear);
        return () => removeEventListener('dragend', clear);
    }, []);
    return {
        dropIndicatorLeft,
        onDragStart: (event) => {
            const sessionId = sessionTabIdAt(event.target);
            if (!sessionId) return;
            draggedIdReference.current = sessionId;
            droppedReference.current = false;
            event.dataTransfer.setData(SESSION_TAB_DRAG_TYPE, sessionId);
            event.dataTransfer.effectAllowed = 'move';
        },
        onDragEnd: (event) => {
            const sessionId = sessionTabIdAt(event.target);
            if (
                !sessionId ||
                !shouldTearOffSessionTab({
                    dropEffect: event.dataTransfer.dropEffect,
                    dropped: droppedReference.current,
                    tabCount: getOpenSessionIds().length,
                })
            )
                return;
            // Chromium reports a `dragend` that left the window with `screenX/Y` of `0,0` on some platforms (a long-standing
            // quirk VS Code works around the same way in its tab drag handler), so a zero point means "unknown" and Main
            // uses the cursor position instead of opening the window at the screen corner.
            const hasPoint = event.screenX !== 0 || event.screenY !== 0;
            // Fire-and-forget: the command toasts its own failure.
            // eslint-disable-next-line no-void -- intentional floating-promise discard
            void tearOffSessionTab(
                sessionId,
                hasPoint ? { x: event.screenX, y: event.screenY } : undefined,
            );
        },
        onDragLeave: (event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDropIndicatorLeft(undefined);
        },
        onDragOver: (event) => {
            if (!canAcceptDrop(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            const list = listReference.current;
            const geometry = list && dropGeometry(list, draggedIdReference.current, event.clientX);
            if (!list || !geometry) return;
            setDropIndicatorLeft(geometry.edgeX - list.getBoundingClientRect().left);
        },
        onDrop: (event) => {
            droppedReference.current = true;
            setDropIndicatorLeft(undefined);
            const sessionId = event.dataTransfer.getData(SESSION_TAB_DRAG_TYPE);
            draggedIdReference.current = undefined;
            const list = listReference.current;
            if (!sessionId || !list) return;
            event.preventDefault();
            const geometry = dropGeometry(list, sessionId, event.clientX);
            if (!geometry) return;
            // Fire-and-forget: the reorder toasts its own failure.
            // eslint-disable-next-line no-void -- intentional floating-promise discard
            void reorderSessionTab(sessionId, geometry.index);
        },
    };
}
