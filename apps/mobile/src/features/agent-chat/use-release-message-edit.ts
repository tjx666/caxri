import { useEffect, useRef } from 'react';

import type { AgentChatController } from './use-agent-chat';

/**
 * Ends a pending "Edit from Here" when the reader leaves its Session: the composer puts back the draft the edit held,
 * as Cancel would. The edit lives in the Chat's React state while the draft is saved per Session, so without this a
 * detail that unmounts or moves to another Session forgets the edit and leaves the edited message as a plain draft,
 * which then sends as a new message and loses what was typed before.
 */
export function useReleaseMessageEdit(
    chat: AgentChatController | undefined,
    sessionId: string,
    onDraftChange: (draft: string) => void,
): void {
    const latest = useRef({ chat, onDraftChange });
    useEffect(() => {
        latest.current = { chat, onDraftChange };
    });
    useEffect(
        () => () => {
            // Cleanups run before this commit's effects update `latest`, so it still holds the Session being left.
            const { chat: left, onDraftChange: setLeftDraft } = latest.current;
            const edit = left?.editing;
            if (!left || !edit) return;
            left.setEditing(undefined);
            setLeftDraft(edit.previousDraft);
        },
        [sessionId],
    );
}
