import type { MouseEvent as ReactMouseEvent } from 'react';

/**
 * The gesture that asked a row for its context menu: where the pointer was, and whether the row itself held focus when
 * it arrived.
 */
export interface RowContextMenuGesture {
    clientX: number;
    clientY: number;
    /**
     * True when the row was the active element, which is how the keyboard path (`Ctrl+Shift+F10`, the menu key)
     * arrives. Mounting the menu replaces the row's DOM node and drops that focus, and Base UI restores whatever was
     * focused when the popup opened — so the replay has to put focus back on the row first, or closing the menu would
     * strand focus on `<body>` instead of returning it to the row.
     */
    hadFocus: boolean;
}

/**
 * The only row capabilities the replay needs. Narrow on purpose: it keeps this module testable without a DOM.
 */
export interface ReplayableRow {
    dispatchEvent: (event: Event) => boolean;
    focus: (options?: FocusOptions) => void;
}

/**
 * A row renders its Base UI context-menu subtree only once that row has actually been right-clicked. Every mounted
 * `ContextMenu` costs a `MenuRoot` plus a `FloatingTree`, and each of those re-renders once after mounting, so a tree
 * of rows used to pay for menus the user never opened.
 */
export function shouldRenderRowContextMenu(isEditable: boolean, isRequested: boolean): boolean {
    return isEditable && isRequested;
}

function contextMenuEvent(gesture: RowContextMenuGesture): Event {
    return new MouseEvent('contextmenu', {
        bubbles: true,
        button: 2,
        buttons: 2,
        cancelable: true,
        clientX: gesture.clientX,
        clientY: gesture.clientY,
    });
}

/**
 * Re-delivers the original gesture to the trigger that only exists after this commit.
 *
 * `ContextMenuTrigger` opens from its own `onContextMenu` handler and anchors the popup to that event's client
 * coordinates, so a lazily mounted trigger has no way to learn about the right click that mounted it. Replaying the
 * event is what keeps the menu appearing at the cursor within the same gesture instead of forcing a second right click;
 * it also preserves every other behavior the trigger attaches to that gesture (long-press, mouse-up handling, open
 * reason), which a hand-rolled "open at these coordinates" call would silently drop.
 */
export function replayRowContextMenu(
    row: ReplayableRow,
    gesture: RowContextMenuGesture,
    createEvent: (gesture: RowContextMenuGesture) => Event = contextMenuEvent,
): void {
    if (gesture.hadFocus) row.focus({ preventScroll: true });
    row.dispatchEvent(createEvent(gesture));
}

/**
 * Claims the gesture that arrived at a row whose menu does not exist yet, and records what the replay will need.
 *
 * Base UI's trigger stops this event itself once it exists. Until then the row owns that job: an unstopped gesture
 * reaches the tree's root context menu and opens the background menu instead of the row's.
 */
export function claimRowContextMenuGesture(
    event: Pick<
        ReactMouseEvent,
        'clientX' | 'clientY' | 'currentTarget' | 'preventDefault' | 'stopPropagation'
    >,
    activeElement: Element | null,
): RowContextMenuGesture {
    event.preventDefault();
    event.stopPropagation();
    return {
        clientX: event.clientX,
        clientY: event.clientY,
        hadFocus: event.currentTarget === activeElement,
    };
}
