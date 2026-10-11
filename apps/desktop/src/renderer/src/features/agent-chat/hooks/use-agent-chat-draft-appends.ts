import type { Dispatch, SetStateAction } from 'react';
import { useEffect } from 'react';

import {
    draftWithParagraph,
    subscribeAgentChatDraftAppends,
    writeAgentChatDraft,
} from '../agent-chat-drafts';

/**
 * Takes text another surface appends to this Chat's message (a turn review comment) into the composer's live draft,
 * persisted like any edit, while the composer is mounted.
 */
export function useAgentChatDraftAppends(
    terminalId: string,
    setDraft: Dispatch<SetStateAction<string>>,
): void {
    useEffect(
        () =>
            subscribeAgentChatDraftAppends(terminalId, (text) =>
                setDraft((current) => {
                    const next = draftWithParagraph(current, text);
                    writeAgentChatDraft(terminalId, next);
                    return next;
                }),
            ),
        [setDraft, terminalId],
    );
}
