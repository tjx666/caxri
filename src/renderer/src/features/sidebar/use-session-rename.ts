import { useCallback, useEffect, useRef, useState } from 'react';

import type { SessionRecord } from '@shared/types';

import { renameSession } from '../session/session-actions';

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

/**
 * Session-rename state machine extracted from `ProjectSidebar` (react-doctor's giant-component
 * threshold) so the roving-tabindex tree layout stays the only concern left in that component.
 * Owns the renaming Session id, the draft value/error, and the focus-restore behavior after
 * rename ends.
 */
export function useSessionRename(sessions: SessionRecord[]): SessionRenameController {
    const [renamingSessionId, setRenamingSessionId] = useState<string>();
    const [renameValue, setRenameValue] = useState('');
    const [renameError, setRenameError] = useState<string>();
    const renamingSessionIdRef = useRef<string | undefined>(undefined);
    const restoreFocusSessionIdRef = useRef<string | undefined>(undefined);

    const focusRenameInput = useCallback((element: HTMLInputElement | null) => {
        element?.focus();
        element?.select();
    }, []);

    useEffect(() => {
        if (renamingSessionId) return;
        const sessionId = restoreFocusSessionIdRef.current;
        if (!sessionId) return;
        document.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`)?.focus();
        restoreFocusSessionIdRef.current = undefined;
    }, [renamingSessionId, sessions]);

    const beginRename = (sessionId: string, displayTitle: string): void => {
        renamingSessionIdRef.current = sessionId;
        setRenamingSessionId(sessionId);
        setRenameValue(displayTitle);
        setRenameError(undefined);
    };

    /**
     * Clearing the active id synchronously makes key-repeat submissions no-ops. Blur deliberately
     * skips focus restoration so the control the user clicked keeps focus.
     */
    const finishRename = (sessionId: string, restoreFocus: boolean): void => {
        if (renamingSessionIdRef.current !== sessionId) return;
        renamingSessionIdRef.current = undefined;
        if (restoreFocus) restoreFocusSessionIdRef.current = sessionId;
        setRenamingSessionId((current) => (current === sessionId ? undefined : current));
        setRenameError(undefined);
    };

    const cancelRename = (): void => {
        const sessionId = renamingSessionIdRef.current;
        if (sessionId) finishRename(sessionId, true);
    };

    const commitRename = (): void => {
        const sessionId = renamingSessionIdRef.current;
        if (!sessionId) return;
        const displayTitle = renameValue.trim();
        if (!displayTitle) {
            setRenameError('Session name is required');
            return;
        }
        const currentTitle = sessions.find((session) => session.id === sessionId)?.displayTitle;
        finishRename(sessionId, true);
        if (displayTitle !== currentTitle) void renameSession(sessionId, displayTitle);
    };

    const blurRename = (): void => {
        const sessionId = renamingSessionIdRef.current;
        if (!sessionId) return;
        const displayTitle = renameValue.trim();
        const currentTitle = sessions.find((session) => session.id === sessionId)?.displayTitle;
        finishRename(sessionId, false);
        if (displayTitle && displayTitle !== currentTitle)
            void renameSession(sessionId, displayTitle);
    };

    const onRenameValueChange = (value: string): void => {
        setRenameValue(value);
        setRenameError(undefined);
    };

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
