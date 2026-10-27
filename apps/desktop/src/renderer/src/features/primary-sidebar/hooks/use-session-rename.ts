import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SessionRecord } from '@caxri/protocol';

import { useLatestReference } from '../../../hooks/use-latest-reference';
import { translate } from '../../../i18n';
import { clearSessionRenameRequest, useDialogStore } from '../../../stores/dialogs';
import { didRenameSession } from '../../session/session-commands';
import { sessionTitleForDisplay } from '../../session/session-title';
import { suggestSessionTitle } from '../../session/session-title-suggestion-commands';
import {
    decideSessionRename,
    landSessionTitleSuggestion,
    syncUntouchedRenameDraft,
} from '../session-rename-draft';

export interface SessionRenameController {
    beginRename: (sessionId: string, title: string, rowId: string) => void;
    blurRename: () => void;
    cancelRename: () => void;
    commitRename: () => void;
    focusRenameInput: (element: HTMLInputElement | null) => void;
    onRenameValueChange: (value: string) => void;
    renameError?: string;
    renameValue: string;
    /**
     * The Session whose AI name suggestion is in flight. Rows compare it with their own Session rather than receiving a
     * boolean, so a suggestion still pending after its editor closed never shows as loading in another row's editor.
     */
    renameSuggestingSessionId?: string;
    /**
     * Opens the row's editor if it is not already open, then asks the Server for a name generated from the Session's
     * Agent conversation and puts it into the editor fully selected (see `landSessionTitleSuggestion`): Enter accepts
     * it, typing edits it, and Escape keeps the old title.
     */
    suggestRename: (sessionId: string, title: string, rowId: string) => void;
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
 * Session-rename state machine shared by the Project tree and Activity view. Owns the renaming Session id, the draft
 * value/error, and the focus-restore behavior after rename ends.
 */
export function useSessionRename(
    sessions: SessionRecord[],
    /**
     * Puts the Session's row on screen and returns the row id that now holds it. The Project tree may expand its
     * Project or Pinned group; Activity already shows every row it can rename.
     */
    revealSessionRow: (session: SessionRecord) => string,
): SessionRenameController {
    const [renamingRowId, setRenamingRowId] = useState<string>();
    const [renameValue, setRenameValue] = useState('');
    const [renameError, setRenameError] = useState<string>();
    const [renameSuggestingSessionId, setRenameSuggestingSessionId] = useState<string>();
    /**
     * Identity of the suggestion in flight. A result applies only while this still holds the same object: Escape, a
     * typed commit, or a newer suggestion replaces or clears it, so a late provider answer cannot overwrite them.
     */
    const suggestionReference = useRef<{ sessionId: string } | undefined>(undefined);
    const renamingSessionIdReference = useRef<string | undefined>(undefined);
    const renamingRowIdReference = useRef<string | undefined>(undefined);
    /**
     * The title the editor opened with (or last synced to). Commit and blur compare the draft with this rather than the
     * Session's current title, so an automatic name landing mid-edit is not reverted by an untouched draft.
     */
    const renameBaselineReference = useRef('');
    /**
     * Whether the user typed into the open editor. An untouched draft follows automatic naming; an edited one never
     * does.
     */
    const isRenameDraftEditedReference = useRef(false);
    const restoreFocusRowIdReference = useRef<string | undefined>(undefined);
    const restoreFocusVisibleReference = useRef(false);
    /**
     * The suggestion path compares its answer with the Session's current title. Read through a ref rather than closed
     * over: the list is replaced on every Session switch (the Server stamps the opened Session's `lastVisitedAt`), and
     * handlers rebuilt from it would reach every row as new props and render all of them again (issue #1356).
     */
    const latestSessions = useLatestReference(sessions);
    const latestRevealSessionRow = useLatestReference(revealSessionRow);
    /**
     * The mounted rename input, so a suggestion that arrives after it mounted can select the text it just filled in.
     */
    const renameInputReference = useRef<HTMLInputElement | null>(null);
    /**
     * Bumped when a suggestion fills the draft; the effect below selects the whole draft after that value rendered.
     */
    const [selectAllRevision, setSelectAllRevision] = useState(0);

    const focusRenameInput = useCallback((element: HTMLInputElement | null) => {
        renameInputReference.current = element;
        element?.focus();
        element?.select();
    }, []);

    useEffect(() => {
        if (selectAllRevision === 0) return;
        renameInputReference.current?.focus();
        renameInputReference.current?.select();
    }, [selectAllRevision]);

    useEffect(() => {
        if (renamingRowId) return;
        const rowId = restoreFocusRowIdReference.current;
        if (!rowId) return;
        treeRow(rowId)?.focus({ focusVisible: restoreFocusVisibleReference.current });
        restoreFocusRowIdReference.current = undefined;
    }, [renamingRowId, sessions]);

    /**
     * Automatic naming can replace the title while the editor is open. An untouched draft follows it, so the editor
     * shows the name that just arrived; a draft the user already edited keeps their text.
     */
    useEffect(() => {
        const sessionId = renamingSessionIdReference.current;
        if (!sessionId) return;
        const currentTitle = sessions.find((session) => session.id === sessionId)?.title;
        const next = syncUntouchedRenameDraft(
            isRenameDraftEditedReference.current,
            renameBaselineReference.current,
            currentTitle === undefined
                ? undefined
                : sessionTitleForDisplay(currentTitle, translate),
        );
        if (next === undefined) return;
        renameBaselineReference.current = next;
        setRenameValue(next);
    }, [sessions]);

    const beginRename = useCallback((sessionId: string, title: string, rowId: string): void => {
        /**
         * Record how the row was focused before the input replaces it. `focus()` always applies `:focus-visible`, so
         * restoring focus after a rename started by double-click drew a white ring around a row the user had only ever
         * clicked: a focus indicator standing for keyboard navigation that never happened.
         */
        restoreFocusVisibleReference.current = treeRow(rowId)?.matches(':focus-visible') === true;
        renamingSessionIdReference.current = sessionId;
        renamingRowIdReference.current = rowId;
        /**
         * The editor starts from the title the row shows, so an unnamed Session opens on the localized `Untitled` and
         * committing it unchanged is a no-op rather than a rename to the translation.
         */
        const shownTitle = sessionTitleForDisplay(title, translate);
        renameBaselineReference.current = shownTitle;
        isRenameDraftEditedReference.current = false;
        setRenamingRowId(rowId);
        setRenameValue(shownTitle);
        setRenameError(undefined);
    }, []);

    /**
     * Clearing the active id synchronously makes key-repeat submissions no-ops. Blur deliberately skips focus
     * restoration so the control the user clicked keeps focus.
     */
    const finishRename = useCallback((sessionId: string, shouldRestoreFocus: boolean): void => {
        if (renamingSessionIdReference.current !== sessionId) return;
        const rowId = renamingRowIdReference.current;
        renamingSessionIdReference.current = undefined;
        renamingRowIdReference.current = undefined;
        if (shouldRestoreFocus && rowId) restoreFocusRowIdReference.current = rowId;
        setRenamingRowId((current) => (current === rowId ? undefined : current));
        setRenameError(undefined);
    }, []);

    const dropSuggestion = useCallback((sessionId: string): void => {
        if (suggestionReference.current?.sessionId !== sessionId) return;
        suggestionReference.current = undefined;
        setRenameSuggestingSessionId(undefined);
    }, []);

    const cancelRename = useCallback((): void => {
        const sessionId = renamingSessionIdReference.current;
        if (!sessionId) return;
        dropSuggestion(sessionId);
        finishRename(sessionId, true);
    }, [dropSuggestion, finishRename]);

    const commitRename = useCallback((): void => {
        const sessionId = renamingSessionIdReference.current;
        if (!sessionId) return;
        // The input is read-only while a suggestion is pending; Enter there must not discard the answer on its way.
        if (suggestionReference.current?.sessionId === sessionId) return;
        const decision = decideSessionRename(renameValue, renameBaselineReference.current);
        if (decision.kind === 'empty') {
            setRenameError(translate('primarySidebar.rename.required'));
            return;
        }
        finishRename(sessionId, true);
        // Fire-and-forget: `didRenameSession` funnels its own failures into a toast.
        if (decision.kind === 'rename') void didRenameSession(sessionId, decision.title);
    }, [renameValue, finishRename]);

    const blurRename = useCallback((): void => {
        const sessionId = renamingSessionIdReference.current;
        if (!sessionId) return;
        const decision = decideSessionRename(renameValue, renameBaselineReference.current);
        finishRename(sessionId, false);
        /**
         * Clicking away while a suggestion is pending keeps it: the user asked for an AI name and the editor merely
         * lost focus, so the answer still lands when it arrives. The draft cannot have changed, because the input is
         * read-only for that whole time.
         */
        if (suggestionReference.current?.sessionId === sessionId) return;
        // Fire-and-forget: `didRenameSession` funnels its own failures into a toast.
        if (decision.kind === 'rename') void didRenameSession(sessionId, decision.title);
    }, [renameValue, finishRename]);

    const suggestRename = useCallback(
        (sessionId: string, title: string, rowId: string): void => {
            if (renamingRowIdReference.current !== rowId) beginRename(sessionId, title, rowId);
            if (suggestionReference.current?.sessionId === sessionId) return;
            const request = { sessionId };
            suggestionReference.current = request;
            setRenameSuggestingSessionId(sessionId);
            setRenameError(undefined);
            // Fire-and-forget: `suggestSessionTitle` funnels its own failures into a toast.
            void suggestSessionTitle(sessionId).then((suggestion) => {
                if (suggestionReference.current !== request) return;
                suggestionReference.current = undefined;
                setRenameSuggestingSessionId(undefined);
                // On failure the editor stays open with the draft untouched, so the user can type a name instead.
                if (!suggestion) return;
                const landing = landSessionTitleSuggestion(
                    renamingSessionIdReference.current,
                    sessionId,
                );
                if (landing === 'discard') return;
                if (landing === 'reopen') {
                    const session = latestSessions.current.find(
                        (candidate) => candidate.id === sessionId,
                    );
                    if (!session) return;
                    beginRename(sessionId, session.title, latestRevealSessionRow.current(session));
                }
                // Marked as the user's draft so an automatic name landing next does not replace the suggestion.
                isRenameDraftEditedReference.current = true;
                setRenameValue(suggestion);
                setRenameError(undefined);
                setSelectAllRevision((revision) => revision + 1);
            });
        },
        [beginRename, latestRevealSessionRow, latestSessions],
    );

    const onRenameValueChange = useCallback((value: string): void => {
        isRenameDraftEditedReference.current = true;
        setRenameValue(value);
        setRenameError(undefined);
    }, []);

    /**
     * The `session.rename` command's way in. Renaming is React state owned by this hook, so a command (which runs
     * outside React entirely) asks through a bumped revision on the dialog store rather than reaching into the row.
     * Bumped rather than set to a boolean so asking twice for the same Session re-opens the editor the second time.
     */
    const renameRequest = useDialogStore((state) => state.renameSessionRequest);
    const latestBeginRename = useLatestReference(beginRename);
    const latestSuggestRename = useLatestReference(suggestRename);
    useEffect(() => {
        if (!renameRequest) return;
        const session = latestSessions.current.find(
            (candidate) => candidate.id === renameRequest.sessionId,
        );
        if (session) {
            // The rename editor _is_ the Session row, and a collapsed group unmounts it. Without this the command
            // would put a Session nobody can see into rename mode: nothing happens on screen, and the row opens in an
            // editor the user never asked for whenever they later expand that group. The row id has to come back from
            // the same call, because a pinned Session has no row under its Project at all.
            const rowId = latestRevealSessionRow.current(session);
            // `session.renameWithAi` asks for the same suggestion the row's `Shift+Enter` does.
            if (renameRequest.suggest)
                latestSuggestRename.current(session.id, session.title, rowId);
            else latestBeginRename.current(session.id, session.title, rowId);
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

    /**
     * Memoized for the same reason as `useSessionOrder`'s return (issues #1108 and #1356): every Session row receives
     * these methods as props, and a fresh controller object on every render of the Project tree (including a plain
     * Session switch, which never touches renaming) would render every row again whether or not its own content
     * changed. React Compiler does not help here either: it refuses to optimize any function containing an ESLint rule
     * suppression, and the effect above carries one.
     */
    return useMemo(
        () => ({
            beginRename,
            blurRename,
            cancelRename,
            commitRename,
            focusRenameInput,
            onRenameValueChange,
            renameError,
            renameSuggestingSessionId,
            renameValue,
            renamingRowId,
            suggestRename,
        }),
        [
            beginRename,
            blurRename,
            cancelRename,
            commitRename,
            focusRenameInput,
            onRenameValueChange,
            renameError,
            renameSuggestingSessionId,
            renameValue,
            renamingRowId,
            suggestRename,
        ],
    );
}
