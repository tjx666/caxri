import type { RefObject } from 'react';
import { useState } from 'react';

import type { AgentChatPathReference } from '@caxri/protocol';
import { agentChatDraftWithReturnedMessage, parseAgentChatPathReferences } from '@caxri/protocol';

import { readAgentChatDraft, writeAgentChatDraft } from '../agent-chat-drafts';
import { useAgentChatDraftUpdates } from './use-agent-chat-draft-updates';

/**
 * The composer's draft text, kept per Chat across remounts and restarts, with the edits that write into it from outside
 * the input: a queued message pulled back for editing and what another surface writes into it (Add to message, a turn
 * review comment, Paste as Text). Dropped and pasted content goes through `useAgentChatComposerInput`.
 */
export function useAgentChatDraft({
    addPaths,
    inputReference,
    terminalId,
}: {
    /**
     * Attaches the file and folder cards of a queued message pulled back for editing.
     */
    addPaths: (references: readonly AgentChatPathReference[]) => unknown;
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
    useAgentChatDraftUpdates(terminalId, setDraftState);
    /**
     * Empties the draft without `setDraft`'s updater. A handoff's new Chat takes the tab before it resolves, so the
     * composer has usually unmounted by then and an updater, which persists the draft, would never run.
     */
    const clearDraft = (): void => {
        writeAgentChatDraft(terminalId, '');
        setDraftState('');
    };
    const restoreQueued = (message: string): void => {
        const { references, text } = parseAgentChatPathReferences(message);
        addPaths(references);
        setDraft((current) => agentChatDraftWithReturnedMessage(current, text));
        inputReference.current?.focus();
    };
    return { clearDraft, draft, restoreQueued, setDraft };
}
