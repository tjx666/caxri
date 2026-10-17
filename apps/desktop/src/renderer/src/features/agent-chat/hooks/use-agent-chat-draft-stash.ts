import type { KeyboardEvent } from 'react';
import { useEffect, useRef } from 'react';

import { useLatestReference } from '../../../hooks/use-latest-reference';
import { isImeComposing } from '../../../lib/ime';
import { tryCommand } from '../../../stores/toasts';
import { isAgentChatStashKey } from '../agent-chat-composer-keys';
import { currentAgentChatDraftStashStore } from '../agent-chat-draft-stash';
import { readAgentChatAttachments, settleAgentChatAttachments } from '../agent-chat-drafts';
import { setAgentChatGoalMode } from '../agent-chat-goal-mode';
import type { useAgentChatAttachments } from './use-agent-chat-attachments';
import { useAgentChatInputSelection } from './use-agent-chat-input-selection';

interface DraftStashProperties {
    draft: string;
    images: Pick<ReturnType<typeof useAgentChatAttachments>, 'attachments' | 'replace'>;
    isAttaching: boolean;
    isEditing: boolean;
    isGoalMode: boolean;
    isSending: boolean;
    setDraft: (update: (current: string) => string) => void;
    terminalId: string;
}

/**
 * Ctrl+S checkpoints an input before clearing it, or explicitly restores its last checkpoint into a wholly empty input.
 */
export function useAgentChatDraftStash(properties: DraftStashProperties) {
    const restoreSelection = useAgentChatInputSelection(properties.draft);
    const latest = useLatestReference(properties);
    const mounted = useRef(false);
    const pending = useRef(false);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    const didHandleKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
        if (
            properties.isEditing ||
            !isAgentChatStashKey({ ...event, isComposing: isImeComposing(event) })
        )
            return false;
        event.preventDefault();
        if (event.repeat || pending.current || properties.isAttaching || properties.isSending)
            return true;
        const input = event.currentTarget;
        const before = properties;
        const selectionStart = input.selectionStart;
        const selectionEnd = input.selectionEnd;
        const selectionDirection = input.selectionDirection;
        const store = currentAgentChatDraftStashStore();
        const isUnchanged = (): boolean => {
            const current = latest.current;
            return (
                mounted.current &&
                input.isConnected &&
                current.terminalId === before.terminalId &&
                current.draft === before.draft &&
                current.images.attachments === before.images.attachments &&
                current.isGoalMode === before.isGoalMode &&
                !current.isAttaching &&
                !current.isEditing &&
                !current.isSending &&
                input.value === before.draft &&
                input.selectionStart === selectionStart &&
                input.selectionEnd === selectionEnd
            );
        };
        pending.current = true;
        // eslint-disable-next-line no-void -- tryCommand reports failures and leaves the live draft untouched
        void tryCommand('Stash draft', async () => {
            await settleAgentChatAttachments();
            if (!isUnchanged()) return;
            const hydrated = readAgentChatAttachments(before.terminalId);
            if (
                hydrated.length !== before.images.attachments.length ||
                hydrated.some(
                    (attachment, index) => attachment.id !== before.images.attachments[index]?.id,
                )
            )
                return;
            if (before.draft.length > 0 || before.images.attachments.length > 0) {
                await store.save(before.terminalId, {
                    text: before.draft,
                    attachments: before.images.attachments,
                    selectionStart,
                    selectionEnd,
                    selectionDirection,
                    isGoalMode: before.isGoalMode,
                });
                if (!isUnchanged()) return;
                before.setDraft(() => '');
                before.images.replace([]);
                setAgentChatGoalMode(before.terminalId, false);
                return;
            }
            const stash = await store.read(before.terminalId);
            if (!stash || !isUnchanged()) return;
            restoreSelection({
                textarea: input,
                text: stash.text,
                start: stash.selectionStart,
                end: stash.selectionEnd,
                direction: stash.selectionDirection,
            });
            before.setDraft(() => stash.text);
            before.images.replace(stash.attachments);
            setAgentChatGoalMode(before.terminalId, stash.isGoalMode);
        }).finally(() => {
            pending.current = false;
        });
        return true;
    };
    return { didHandleKey };
}
