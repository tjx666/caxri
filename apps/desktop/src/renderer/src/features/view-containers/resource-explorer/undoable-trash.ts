import { createStore } from '../../../lib/store';

/**
 * The one Move to Trash that Cmd+Z in the Files tree may take back (issue #3072).
 *
 * A single slot rather than a stack: the shortcut promises "undo the latest file operation", and only Trash is
 * undoable. Any later operation that changes paths (create, rename, move, copy, another Trash) makes an older Trash the
 * wrong thing to restore, so those call `forgetUndoableTrash` and the shortcut then does nothing. Server stays the
 * authority on whether the receipt is still valid (Project root, identity check, no overwrite).
 */
export interface UndoableTrash {
    name: string;
    sessionId: string;
    undoToken: string;
}

interface UndoableTrashState {
    latest: UndoableTrash | undefined;
}

const useUndoableTrashStore = createStore<UndoableTrashState>('undoable-trash', () => ({
    latest: undefined,
}));

export function rememberUndoableTrash(trash: UndoableTrash): void {
    useUndoableTrashStore.setState({ latest: trash });
}

/**
 * Returns the Trash Cmd+Z would restore for `sessionId`, or `undefined` when there is none for that Session.
 */
export function undoableTrashFor(sessionId: string): UndoableTrash | undefined {
    const { latest } = useUndoableTrashStore.getState();
    return latest?.sessionId === sessionId ? latest : undefined;
}

/**
 * Drops the slot. With `undoToken`, only when it still holds that receipt, so the toast's Undo for an older Trash
 * cannot discard a newer one.
 */
export function forgetUndoableTrash(undoToken?: string): void {
    const { latest } = useUndoableTrashStore.getState();
    if (undoToken === undefined || latest?.undoToken === undoToken)
        useUndoableTrashStore.setState({ latest: undefined });
}
