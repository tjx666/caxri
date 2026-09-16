import { useCallback, useEffect, useRef, useState } from 'react';

import type { SessionRecord } from '@caxri/protocol';

import { useLatestReference } from '../../../hooks/use-latest-reference';
import { clearSessionRenameRequest, useDialogStore } from '../../../stores/dialogs';
import { didRenameSession } from '../../session/session-commands';

export interface SessionRenameController {
    beginRename: (sessionId: string, displayTitle: string, rowId: string) => void;
    blurRename: () => void;
    cancelRename: () => void;
    commitRename: () => void;
    focusRenameInput: (element: HTMLInputElement | null) => void;
    onRenameValueChange: (value: string) => void;
    renameError?: string;
    renameValue: string;
    /**
     * The tree row currently showing the rename input, not the Session id: a pinned Session has a row in the Pinned
     * group and another under its own Project, and only the one the user started the rename from may swap itself for a
     * text field. Keying this by Session would put two inputs on screen, both claiming focus.
     */
    renamingRowId?: string;
}

function treeRow(rowId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(rowId)}"]`);
}

/**
 * Session-rename state machine extracted from `PrimarySidebar` (react-doctor's giant-component threshold) so the
 * roving-tabindex tree layout stays the only concern left in that component. Owns the renaming Session id, the draft
 * value/error, and the focus-restore behavior after rename ends.
 */
export function useSessionRename(
    sessions: SessionRecord[],
    expandProject: (projectId: string) => void,
): SessionRenameController {
    const [renamingRowId, setRenamingRowId] = useState<string>();
    const [renameValue, setRenameValue] = useState('');
    const [renameError, setRenameError] = useState<string>();
    const renamingSessionIdReference = useRef<string | undefined>(undefined);
    const renamingRowIdReference = useRef<string | undefined>(undefined);
    const restoreFocusRowIdReference = useRef<string | undefined>(undefined);
    const restoreFocusVisibleReference = useRef(false);

    const focusRenameInput = useCallback((element: HTMLInputElement | null) => {
        element?.focus();
        element?.select();
    }, []);

    useEffect(() => {
        if (renamingRowId) return;
        const rowId = restoreFocusRowIdReference.current;
        if (!rowId) return;
        treeRow(rowId)?.focus({ focusVisible: restoreFocusVisibleReference.current });
        restoreFocusRowIdReference.current = undefined;
    }, [renamingRowId, sessions]);

    const beginRename = (sessionId: string, displayTitle: string, rowId: string): void => {
        /**
         * Record how the row was focused before the input replaces it. `focus()` always applies `:focus-visible`, so
         * restoring focus after a rename started by double-click drew a white ring around a row the user had only ever
         * clicked — a focus indicator standing for keyboard navigation that never happened.
         */
        restoreFocusVisibleReference.current = treeRow(rowId)?.matches(':focus-visible') === true;
        renamingSessionIdReference.current = sessionId;
        renamingRowIdReference.current = rowId;
        setRenamingRowId(rowId);
        setRenameValue(displayTitle);
        setRenameError(undefined);
    };

    /**
     * Clearing the active id synchronously makes key-repeat submissions no-ops. Blur deliberately skips focus
     * restoration so the control the user clicked keeps focus.
     */
    const finishRename = (sessionId: string, shouldRestoreFocus: boolean): void => {
        if (renamingSessionIdReference.current !== sessionId) return;
        const rowId = renamingRowIdReference.current;
        renamingSessionIdReference.current = undefined;
        renamingRowIdReference.current = undefined;
        if (shouldRestoreFocus && rowId) restoreFocusRowIdReference.current = rowId;
        setRenamingRowId((current) => (current === rowId ? undefined : current));
        setRenameError(undefined);
    };

    const cancelRename = (): void => {
        const sessionId = renamingSessionIdReference.current;
        if (sessionId) finishRename(sessionId, true);
    };

    const commitRename = (): void => {
        const sessionId = renamingSessionIdReference.current;
        if (!sessionId) return;
        const displayTitle = renameValue.trim();
        if (!displayTitle) {
            setRenameError('Session name is required');
            return;
        }
        const currentTitle = sessions.find((session) => session.id === sessionId)?.displayTitle;
        finishRename(sessionId, true);
        // Fire-and-forget: `didRenameSession` funnels its own failures into a toast.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        if (displayTitle !== currentTitle) void didRenameSession(sessionId, displayTitle);
    };

    const blurRename = (): void => {
        const sessionId = renamingSessionIdReference.current;
        if (!sessionId) return;
        const displayTitle = renameValue.trim();
        const currentTitle = sessions.find((session) => session.id === sessionId)?.displayTitle;
        finishRename(sessionId, false);
        // Fire-and-forget: `didRenameSession` funnels its own failures into a toast.
        if (displayTitle && displayTitle !== currentTitle)
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void didRenameSession(sessionId, displayTitle);
    };

    const onRenameValueChange = (value: string): void => {
        setRenameValue(value);
        setRenameError(undefined);
    };

    /**
     * The `session.rename` command's only way in. Renaming is React state owned by this hook, so a command — which runs
     * outside React entirely — asks through a bumped revision on the dialog store rather than reaching into the row.
     * Bumped rather than set to a boolean so asking twice for the same Session re-opens the editor the second time.
     */
    const renameRequest = useDialogStore((state) => state.renameSessionRequest);
    const latestBeginRename = useLatestReference(beginRename);
    const latestExpandProject = useLatestReference(expandProject);
    const latestSessions = useLatestReference(sessions);
    useEffect(() => {
        if (!renameRequest) return;
        const session = latestSessions.current.find(
            (candidate) => candidate.id === renameRequest.sessionId,
        );
        if (session) {
            // The rename editor _is_ the Session row, and a collapsed Project unmounts it. Without this the command
            // would put a Session nobody can see into rename mode: nothing happens on screen, and the row opens in an
            // editor the user never asked for whenever they later expand that Project.
            latestExpandProject.current(session.projectId);
            // Always the Project group's row: that is the one `expandProject` just guaranteed is on screen. The Pinned
            // group may be collapsed, and its copy is a second view of the same Session rather than the canonical one.
            latestBeginRename.current(session.id, session.displayTitle, session.id);
        }
        // Consumed, not just observed. `Cmd+[` unmounts the whole side bar, so a request left standing would run again
        // on the next reveal and drop the row back into an editor nobody asked for. A mount-time revision baseline
        // cannot replace this: `renameSelectedSession` reveals the side bar and bumps the revision in one synchronous
        // turn, so the baseline this hook recorded on mount would already contain the request and swallow it.
        clearSessionRenameRequest();
        // `renameRequest.id` is the signal; the Session list is read through a ref so a Session-list refresh cannot
        // replay a rename the user already finished.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    }, [renameRequest?.id]);

    return {
        beginRename,
        blurRename,
        cancelRename,
        commitRename,
        focusRenameInput,
        onRenameValueChange,
        renameError,
        renameValue,
        renamingRowId,
    };
}
