import type { KeyboardEvent, RefObject } from 'react';
import { useState } from 'react';

import { translate } from '../../../i18n';
import { isImeComposing } from '../../../lib/ime';
import type { AgentChatDraftStash } from '../agent-chat-draft-stash';
import {
    isAgentChatDraftStashKey,
    readAgentChatDraftStash,
    writeAgentChatDraftStash,
} from '../agent-chat-draft-stash';
import type { AgentChatAttachment } from '../agent-chat-drafts';
import { setAgentChatGoalMode, useAgentChatGoalModeStore } from '../agent-chat-goal-mode';
import { useAgentChatComposerNotice } from './use-agent-chat-composer-notice';

/**
 * Ctrl+S stashes the composer's draft and empties it, and Ctrl+S in an empty composer brings it back, as Claude Code's
 * prompt stash does: for a long prompt that has to wait while a quick question goes first. Sending a message also
 * brings the stash back once the composer is empty again, so the set-aside prompt is ready right after the question.
 * The stash keeps the text, the caret, the attachments, and Goal mode.
 */
export function useAgentChatDraftStash({
    attachments,
    clearAttachments,
    draft,
    inputReference,
    restoreAttachments,
    setDraft,
    terminalId,
}: {
    attachments: readonly AgentChatAttachment[];
    clearAttachments: (attachments: readonly AgentChatAttachment[]) => void;
    draft: string;
    inputReference: RefObject<HTMLTextAreaElement | null>;
    restoreAttachments: (attachments: readonly AgentChatAttachment[]) => void;
    setDraft: (update: (current: string) => string) => void;
    terminalId: string;
}) {
    const [stash, setStash] = useState(() => readAgentChatDraftStash(terminalId));
    const isGoalMode = useAgentChatGoalModeStore((state) => state.terminalIds.has(terminalId));
    const notice = useAgentChatComposerNotice();
    const store = (next: AgentChatDraftStash | undefined): void => {
        writeAgentChatDraftStash(terminalId, next);
        setStash(next);
    };
    const restore = (saved: AgentChatDraftStash): void => {
        store(undefined);
        setDraft((current) => (current === '' ? saved.text : current));
        restoreAttachments(saved.attachments);
        if (saved.isGoalMode) setAgentChatGoalMode(terminalId, true);
        const input = inputReference.current;
        const caret = Math.min(saved.caret, saved.text.length);
        // A controlled value change leaves the caret where it was; put it back where the user stashed it.
        requestAnimationFrame(() => input?.setSelectionRange(caret, caret));
    };
    const didHandleKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
        const isStashKey = isAgentChatDraftStashKey({
            key: event.key,
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            isComposing: isImeComposing(event),
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
        });
        if (!isStashKey) return false;
        if (draft.trim() !== '' || attachments.length > 0) {
            event.preventDefault();
            store({
                text: draft,
                caret: event.currentTarget.selectionStart,
                attachments,
                isGoalMode,
            });
            setDraft(() => '');
            clearAttachments(attachments);
            if (isGoalMode) setAgentChatGoalMode(terminalId, false);
            notice.show(translate('agentChat.stash.stashed'));
            return true;
        }
        if (!stash) return false;
        event.preventDefault();
        restore(stash);
        return true;
    };
    return {
        didHandleKey,
        hasStash: stash !== undefined,
        notice: notice.notice,
        /**
         * Brings the stash back after a send, unless the user already started the next draft.
         */
        restoreAfterSend: (): void => {
            if (!readAgentChatDraftStash(terminalId)) return;
            // The send empties the input in the same update; read the input once it has rendered.
            requestAnimationFrame(() => {
                const saved = readAgentChatDraftStash(terminalId);
                if (saved && inputReference.current?.value === '') restore(saved);
            });
        },
    };
}
