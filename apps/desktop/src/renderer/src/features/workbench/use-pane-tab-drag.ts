import type { DragEvent, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { PaneNode } from '@caxri/protocol';

import { workTabId } from '../tabs/work-tab-accessibility';
import { movePaneTab, selectPaneTab } from './pane-actions';
import { PANE_TAB_DRAG_TYPE, resolveTabDropIndex } from './pane-drop-zone';

/**
 * How long a drag has to linger over another tab before that tab's pane treats it as selected, previewing its content
 * the way VS Code does while a tab drag is still in progress (`multiEditorTabsControl.ts`,
 * `DRAG_OVER_OPEN_TAB_THRESHOLD`). The value matches VS Code's deliberately unhurried 1.5s: a shorter delay flips the
 * content under a cursor that is only passing over a tab on its way to the drop position. Mirrors
 * `AUTO_COLLAPSE_IDLE_DELAY_MS`'s naming (`use-project-collapse.ts`).
 */
const TAB_DRAG_HOVER_SWITCH_DELAY_MS = 1500;

function canAcceptDrop(event: DragEvent<HTMLElement>): boolean {
    return event.dataTransfer.types.includes(PANE_TAB_DRAG_TYPE);
}

function paneTabIdAt(target: EventTarget | null): string | undefined {
    return target instanceof Element
        ? (target.closest<HTMLElement>('[data-pane-tab-id]')?.dataset.paneTabId ?? undefined)
        : undefined;
}

/**
 * A pane tab bar's drag-and-drop state and handlers: the drop-target highlight, the insertion-line position, and the
 * hover-preview timer that switches a pane's active tab while a drag lingers over one of its other tabs. Extracted out
 * of `PaneTabBar` so that component stays focused on layout and the tab list itself.
 *
 * `listReference` is the whole `role="tablist"`, spanning both the anchored Terminal segment and the scrolling document
 * segment, so a drop resolves against every tab on the bar and the insertion line shares one coordinate space with
 * them. A drop that lands across the segment boundary is normalized by `orderPaneTabs` in the reducer.
 */
export function usePaneTabDrag(
    pane: PaneNode,
    listReference: RefObject<HTMLDivElement | null>,
): {
    dropIndicatorLeft: number | undefined;
    isDropTarget: boolean;
    onDragEnter: (event: DragEvent<HTMLDivElement>) => void;
    onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
    onDragOver: (event: DragEvent<HTMLDivElement>) => void;
    onDragStart: (event: DragEvent<HTMLDivElement>) => void;
    onDrop: (event: DragEvent<HTMLDivElement>) => void;
} {
    const [isDropTarget, setIsDropTarget] = useState(false);
    const [dropIndicatorLeft, setDropIndicatorLeft] = useState<number | undefined>(undefined);
    const hoverTabIdReference = useRef<string | undefined>(undefined);
    const hoverTimeoutReference = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    /**
     * `dataTransfer.getData` cannot be read during `dragover` (only `types` is exposed before `drop`), so, mirroring
     * `draggedProjectId` in `use-project-order.ts`, the id is captured off the bubbled `dragstart` DOM event instead,
     * which lets `dragover` exclude the dragged tab's own (unmoved) rect from both the insertion-line geometry and the
     * hover-preview target, the same way `onDrop` below already excludes it from its own rects.
     */
    const draggedTabIdReference = useRef<string | undefined>(undefined);
    const clearHoverSwitch = (): void => {
        hoverTabIdReference.current = undefined;
        clearTimeout(hoverTimeoutReference.current);
        hoverTimeoutReference.current = undefined;
    };
    useEffect(() => {
        /**
         * `dragend` fires on the drag source and only bubbles through its own bar's ancestors, so a drag cancelled
         * (Escape, dropped outside any bar) while over a _different_ pane's bar would otherwise leave that other bar's
         * insertion line and pending hover-switch timer stuck. A window-level listener clears every bar's state.
         */
        const onWindowDragEnd = (): void => {
            setDropIndicatorLeft(undefined);
            clearHoverSwitch();
            draggedTabIdReference.current = undefined;
        };
        addEventListener('dragend', onWindowDragEnd);
        return () => {
            removeEventListener('dragend', onWindowDragEnd);
            clearHoverSwitch();
        };
    }, []);
    /**
     * Activating a tab under a live drag must not hand it the keyboard: VS Code previews the dragged-over editor with
     * `openEditor(..., { preserveFocus: true })` (`multiEditorTabsControl.ts`). A previewed Terminal would otherwise
     * pull focus into xterm mid-drag, so it reuses `navigate`'s marker: Document tabs never move focus on activation
     * and are left alone.
     */
    const previewTab = (tabId: string): void => {
        const tab = pane.tabs.find((candidate) => candidate.id === tabId);
        if (tab?.resource.kind === 'terminal') {
            const element = document.querySelector<HTMLElement>(`#${CSS.escape(workTabId(tabId))}`);
            if (element) {
                element.dataset.preserveTerminalFocus = 'true';
                element.focus();
            }
        }
        selectPaneTab(tabId);
    };
    return {
        dropIndicatorLeft,
        isDropTarget,
        onDragStart: (event) => {
            draggedTabIdReference.current = paneTabIdAt(event.target);
        },
        onDragEnter: (event) => {
            if (!canAcceptDrop(event)) return;
            event.preventDefault();
            setIsDropTarget(true);
        },
        onDragLeave: (event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setIsDropTarget(false);
            setDropIndicatorLeft(undefined);
            clearHoverSwitch();
        },
        onDragOver: (event) => {
            if (!canAcceptDrop(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            /**
             * Lingering over another tab previews its content, matching VS Code: the drop still lands where the
             * insertion line points, but the user can see what they are dropping next to while the drag is live.
             */
            const hoveredTabId = paneTabIdAt(event.target);
            const hoverSwitchTargetId =
                hoveredTabId !== draggedTabIdReference.current ? hoveredTabId : undefined;
            if (hoverSwitchTargetId !== hoverTabIdReference.current) {
                hoverTabIdReference.current = hoverSwitchTargetId;
                clearTimeout(hoverTimeoutReference.current);
                hoverTimeoutReference.current = hoverSwitchTargetId
                    ? setTimeout(
                          () => previewTab(hoverSwitchTargetId),
                          TAB_DRAG_HOVER_SWITCH_DELAY_MS,
                      )
                    : undefined;
            }
            const listElement = listReference.current;
            if (!listElement) return;
            const tabElements = listElement.querySelectorAll<HTMLElement>('[data-pane-tab-id]');
            const tabRects: DOMRect[] = [];
            for (const element of tabElements) {
                if (element.dataset.paneTabId !== draggedTabIdReference.current)
                    tabRects.push(element.getBoundingClientRect());
            }
            if (tabRects.length === 0) return;
            const index = resolveTabDropIndex(tabRects, event.clientX);
            const targetRect = index === undefined ? tabRects.at(-1) : tabRects[index];
            if (!targetRect) return;
            /**
             * Viewport-relative, offset only by the list's own origin: the line is positioned in the tablist, which
             * does not scroll, while the tabs it points between may sit in either segment. Every `dragover` remeasures,
             * so a segment scrolled mid-drag still lands the line on the right seam.
             */
            const listRect = listElement.getBoundingClientRect();
            const edgeX = index === undefined ? targetRect.right : targetRect.left;
            setDropIndicatorLeft(edgeX - listRect.left);
        },
        onDrop: (event) => {
            setIsDropTarget(false);
            setDropIndicatorLeft(undefined);
            clearHoverSwitch();
            draggedTabIdReference.current = undefined;
            const tabId = event.dataTransfer.getData(PANE_TAB_DRAG_TYPE);
            if (!tabId) return;
            event.preventDefault();
            const tabElements =
                listReference.current?.querySelectorAll<HTMLElement>('[data-pane-tab-id]') ?? [];
            const tabRects: DOMRect[] = [];
            for (const element of tabElements) {
                if (element.dataset.paneTabId !== tabId)
                    tabRects.push(element.getBoundingClientRect());
            }
            movePaneTab(tabId, pane.id, resolveTabDropIndex(tabRects, event.clientX));
        },
    };
}
