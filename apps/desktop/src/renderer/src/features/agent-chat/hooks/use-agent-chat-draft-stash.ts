import type { RefObject } from 'react';
import { useState } from 'react';

import { translate } from '../../../i18n';
import { isImeComposing } from '../../../lib/ime';
import { setAgentChatGoalMode, useAgentChatGoalModeStore } from '../agent-chat-goal-mode';
import type {
    AgentChatComposerInput,
    AgentChatComposerKeyEvent,
} from '../composer/agent-chat-composer-view';
import type { AgentChatDraftStash } from '../composer-input/agent-chat-draft-stash';
import {
    decideAgentChatStashAction,
    isAgentChatDraftStashKey,
    readAgentChatDraftStash,
    restoredAgentChatDraftText,
    writeAgentChatDraftStash,
} from '../composer-input/agent-chat-draft-stash';
import type { AgentChatAttachment } from '../composer-input/agent-chat-drafts';
import { LONG_NOTICE_MS, useAgentChatComposerNotice } from './use-agent-chat-composer-notice';

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
    inputReference: RefObject<AgentChatComposerInput | null>;
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
        setDraft((current) => restoredAgentChatDraftText(current, saved.text));
        restoreAttachments(saved.attachments);
        if (saved.isGoalMode) setAgentChatGoalMode(terminalId, true);
        notice.show(translate('agentChat.stash.restored'));
        const input = inputReference.current;
        const caret = Math.min(saved.caret, saved.text.length);
        // A controlled value change leaves the caret where it was; put it back where the user stashed it.
        requestAnimationFrame(() => input?.setSelectionRange(caret, caret));
    };
    const didHandleKey = (event: AgentChatComposerKeyEvent): boolean => {
        const isStashKey = isAgentChatDraftStashKey({
            key: event.key,
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            isComposing: isImeComposing(event),
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
        });
        if (!isStashKey) return false;
        const action = decideAgentChatStashAction({
            attachmentCount: attachments.length,
            draft,
            hasStash: stash !== undefined,
        });
        switch (action) {
            case 'ignore': {
                return false;
            }
            case 'refuse-occupied': {
                event.preventDefault();
                notice.show(translate('agentChat.stash.occupied'));
                return true;
            }
            case 'stash': {
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
                notice.show(translate('agentChat.stash.stashed'), LONG_NOTICE_MS);
                return true;
            }
            case 'restore': {
                event.preventDefault();
                if (stash) restore(stash);
                return true;
            }
        }
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
                if (saved && inputReference.current?.value.trim() === '') restore(saved);
            });
        },
    };
}
