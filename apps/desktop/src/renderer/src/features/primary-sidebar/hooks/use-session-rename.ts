import { useCallback, useEffect, useRef, useState } from 'react';

import type { SessionRecord } from '@caxri/protocol';

import { useLatestReference } from '../../../hooks/use-latest-reference';
import { clearSessionRenameRequest, useDialogStore } from '../../../stores/dialogs';
import { didRenameSession } from '../../session/session-commands';

export interface SessionRenameController {
    beginRename: (sessionId: string, displayTitle: string) => void;
    blurRename: () => void;
    cancelRename: () => void;
    commitRename: () => void;
    focusRenameInput: (element: HTMLInputElement | null) => void;
    onRenameValueChange: (value: string) => void;
    renameError?: string;
    renameValue: string;
    renamingSessionId?: string;
}

function sessionRow(sessionId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(sessionId)}"]`);
}

/**
 * Session-rename state machine extracted from `PrimarySidebar` (react-doctor's giant-component threshold) so the
 * roving-tabindex tree layout stays the only concern left in that component. Owns the renaming Session id, the draft
 * value/error, and the focus-restore behavior after rename ends.
 */
export function useSessionRename(sessions: SessionRecord[]): SessionRenameController {
    const [renamingSessionId, setRenamingSessionId] = useState<string>();
    const [renameValue, setRenameValue] = useState('');
    const [renameError, setRenameError] = useState<string>();
    const renamingSessionIdReference = useRef<string | undefined>(undefined);
    const restoreFocusSessionIdReference = useRef<string | undefined>(undefined);
    const restoreFocusVisibleReference = useRef(false);

    const focusRenameInput = useCallback((element: HTMLInputElement | null) => {
        element?.focus();
        element?.select();
    }, []);

    useEffect(() => {
        if (renamingSessionId) return;
        const sessionId = restoreFocusSessionIdReference.current;
        if (!sessionId) return;
        sessionRow(sessionId)?.focus({ focusVisible: restoreFocusVisibleReference.current });
        restoreFocusSessionIdReference.current = undefined;
    }, [renamingSessionId, sessions]);

    const beginRename = (sessionId: string, displayTitle: string): void => {
        /**
         * Record how the row was focused before the input replaces it. `focus()` always applies `:focus-visible`, so
         * restoring focus after a rename started by double-click drew a white ring around a row the user had only ever
         * clicked — a focus indicator standing for keyboard navigation that never happened.
         */
        restoreFocusVisibleReference.current =
            sessionRow(sessionId)?.matches(':focus-visible') === true;
        renamingSessionIdReference.current = sessionId;
        setRenamingSessionId(sessionId);
        setRenameValue(displayTitle);
        setRenameError(undefined);
    };

    /**
     * Clearing the active id synchronously makes key-repeat submissions no-ops. Blur deliberately skips focus
     * restoration so the control the user clicked keeps focus.
     */
    const finishRename = (sessionId: string, shouldRestoreFocus: boolean): void => {
        if (renamingSessionIdReference.current !== sessionId) return;
        renamingSessionIdReference.current = undefined;
        if (shouldRestoreFocus) restoreFocusSessionIdReference.current = sessionId;
        setRenamingSessionId((current) => (current === sessionId ? undefined : current));
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
    const latestSessions = useLatestReference(sessions);
    useEffect(() => {
        if (!renameRequest) return;
        const session = latestSessions.current.find(
            (candidate) => candidate.id === renameRequest.sessionId,
        );
        if (session) latestBeginRename.current(session.id, session.displayTitle);
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
        renamingSessionId,
    };
}
