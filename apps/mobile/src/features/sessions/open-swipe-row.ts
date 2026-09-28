import type { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';

/**
 * The part of a swipeable row the list needs in order to close it.
 */
export type SwipeRow = Pick<SwipeableMethods, 'close'>;

/**
 * Tracks the one Session row whose swipe action is revealed, the way a chat list keeps at most one row open.
 *
 * A drag that starts on another row closes the open one at once, so two Archive actions never show together while the
 * new row follows the finger. The dragged row only counts as open once its release commits to opening; `handleOpen`
 * still closes any other open row for a row that opened without a drag. A scroll or the next tap also closes the open
 * row, and `hasOpen` lets that tap be consumed instead of opening a Session. A row that closes or unmounts reports
 * itself through `handleClose`, which ignores a late close from a row that is no longer the open one.
 */
export function createOpenSwipeRow() {
    let open: SwipeRow | null = null;
    const closeOpen = (): void => {
        const current = open;
        open = null;
        current?.close();
    };
    const closeOther = (row: SwipeRow): void => {
        if (open !== null && open !== row) closeOpen();
    };
    return {
        closeOpen,
        handleClose: (row: SwipeRow): void => {
            if (open === row) open = null;
        },
        handleDragStart: closeOther,
        hasOpen: (): boolean => open !== null,
        handleOpen: (row: SwipeRow): void => {
            closeOther(row);
            open = row;
        },
    };
}
