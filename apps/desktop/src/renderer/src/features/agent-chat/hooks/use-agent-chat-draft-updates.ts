import type { Dispatch, SetStateAction } from 'react';
import { useEffect } from 'react';

import { subscribeAgentChatDraftUpdates, writeAgentChatDraft } from '../agent-chat-drafts';

/**
 * Applies what other surfaces write into this Chat's message (Add to message, a turn review comment, Paste as Text) to
 * the composer's live draft, persisted like any edit, while the composer is mounted (`updateAgentChatDraft`).
 */
export function useAgentChatDraftUpdates(
    terminalId: string,
    setDraft: Dispatch<SetStateAction<string>>,
): void {
    useEffect(
        () =>
            subscribeAgentChatDraftUpdates(terminalId, (update) =>
                setDraft((current) => {
                    const next = update(current);
                    writeAgentChatDraft(terminalId, next);
                    return next;
                }),
            ),
        [setDraft, terminalId],
    );
}
