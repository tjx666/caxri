import { useCallback, useEffect, useRef } from 'react';

/**
 * Whether the draft model text is a change worth committing: blank and untouched text both mean "no change".
 */
export function isModelDraftPending(draft: string, committed: string | undefined): boolean {
    return draft.trim() !== (committed ?? '');
}

/**
 * Tracks the model text being typed into an uncontrolled input and commits it once: on blur or Enter via `commit`, and
 * on unmount, so closing Settings (Esc, Cmd+W) without a blur does not lose the edit. A commit is remembered, so a blur
 * followed by an unmount never writes the same text twice.
 */
export function useModelDraft(stored: string | undefined, onCommit: (text: string) => void) {
    const draftReference = useRef<string | undefined>(undefined);
    const committedReference = useRef(stored);
    const onCommitReference = useRef(onCommit);
    useEffect(() => {
        onCommitReference.current = onCommit;
        committedReference.current = stored;
    });
    const commit = useCallback(() => {
        const draft = draftReference.current;
        // The draft is spent either way, so a later Agent change that clears the model cannot replay it on unmount.
        draftReference.current = undefined;
        if (draft === undefined || !isModelDraftPending(draft, committedReference.current)) return;
        committedReference.current = draft.trim() === '' ? undefined : draft.trim();
        onCommitReference.current(draft);
    }, []);
    const setDraft = useCallback((text: string) => {
        draftReference.current = text;
    }, []);
    useEffect(() => commit, [commit]);
    return { commit, setDraft };
}
