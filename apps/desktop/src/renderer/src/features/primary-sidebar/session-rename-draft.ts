import type { SessionRecord } from '@caxri/protocol';

/**
 * What ending a rename editor should do with its draft.
 *
 * - `rename`: the user typed a different name; commit it through `session.rename`.
 * - `unchanged`: the draft still equals the title the editor opened with, so ending the edit is a cancel.
 * - `empty`: the draft is blank; Enter reports it as an error and blur discards it.
 */
export type SessionRenameDecision =
    { kind: 'empty' } | { kind: 'unchanged' } | { kind: 'rename'; title: string };

/**
 * Decides whether a rename draft is a real rename. The draft is compared with the `baseline` (the title the editor was
 * showing when it opened or last synced), not with the Session's current title: automatic naming can replace `Untitled`
 * while the editor is open, and comparing an untouched `Untitled` draft with the new title read as a deliberate rename
 * back to `Untitled`, which `session.rename` then pinned as a manual title forever.
 */
export function decideSessionRename(draft: string, baseline: string): SessionRenameDecision {
    const title = draft.trim();
    if (!title) return { kind: 'empty' };
    if (title === baseline.trim()) return { kind: 'unchanged' };
    return { kind: 'rename', title };
}

/**
 * The new draft and baseline when the Session's title changes under an open editor whose draft the user has not
 * touched, so the editor shows the name that just arrived instead of a stale one. Returns `undefined` when nothing
 * should change: the title is the same, or the user already edited the draft and their text must win. "Touched" is
 * whether the user typed at all, not whether the draft still equals the baseline: someone who deletes a word and types
 * it back has written that text themselves, and replacing it would erase a choice they just made.
 */
export function syncUntouchedRenameDraft(
    isDraftEdited: boolean,
    baseline: string,
    currentTitle: string | undefined,
): string | undefined {
    if (currentTitle === undefined || currentTitle === baseline) return undefined;
    if (isDraftEdited) return undefined;
    return currentTitle;
}

/**
 * Whether the Server can generate a name for this Session: `session.suggestTitle` reads the primary Agent's
 * conversation, and a Shell-only Session has none, so offering the action there only produces a failure toast.
 */
export function canSuggestSessionTitle(
    session: Pick<SessionRecord, 'primaryAgentTerminalId'>,
): boolean {
    return session.primaryAgentTerminalId !== undefined;
}

/**
 * Where an AI title suggestion goes when it arrives. It is never saved directly: it lands in the rename input, fully
 * selected, so Enter accepts it, typing edits it, and Escape keeps the old title.
 *
 * - `fill`: that Session's editor is still open; the suggestion replaces its draft.
 * - `reopen`: no editor is open (the user clicked away while it was pending); the editor opens prefilled.
 * - `discard`: the user has since started renaming a different Session; their editor is not taken over.
 */
export function landSessionTitleSuggestion(
    renamingSessionId: string | undefined,
    sessionId: string,
): 'discard' | 'fill' | 'reopen' {
    if (renamingSessionId === sessionId) return 'fill';
    return renamingSessionId === undefined ? 'reopen' : 'discard';
}
