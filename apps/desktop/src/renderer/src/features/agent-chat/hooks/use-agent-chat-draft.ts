import type { RefObject } from 'react';
import { useState } from 'react';

import { readAgentChatDraft, writeAgentChatDraft } from '../agent-chat-drafts';
import { draftAfterQueueEdit } from '../agent-chat-queue';
import { useAgentChatDraftAppends } from './use-agent-chat-draft-appends';

/**
 * The composer's draft text, kept per Chat across remounts and restarts, with the edits that write into it from outside
 * the input: a queued message pulled back for editing and text another surface appends (a turn review comment). Dropped
 * and pasted content goes through `useAgentChatComposerInput`.
 */
export function useAgentChatDraft({
    inputReference,
    terminalId,
}: {
    inputReference: RefObject<HTMLTextAreaElement | null>;
    terminalId: string;
}) {
    const [draft, setDraftState] = useState(() => readAgentChatDraft(terminalId));
    const setDraft = (update: (current: string) => string): void =>
        setDraftState((current) => {
            const next = update(current);
            writeAgentChatDraft(terminalId, next);
            return next;
        });
    useAgentChatDraftAppends(terminalId, setDraftState);
    /**
     * Empties the draft without `setDraft`'s updater. A handoff's new Chat takes the tab before it resolves, so the
     * composer has usually unmounted by then and an updater, which persists the draft, would never run.
     */
    const clearDraft = (): void => {
        writeAgentChatDraft(terminalId, '');
        setDraftState('');
    };
    const restoreQueued = (text: string): void => {
        setDraft((current) => draftAfterQueueEdit(current, text));
        inputReference.current?.focus();
    };
    return { clearDraft, draft, restoreQueued, setDraft };
}
