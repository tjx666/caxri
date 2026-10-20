import type { RefObject } from 'react';
import { useImperativeHandle, useRef, useState } from 'react';

import type { AgentChatSnapshot } from '@caxri/protocol';
import { parseAgentChatPathReferences } from '@caxri/protocol';

import { useTranslation } from '../../../i18n';
import type { AgentChatComposerInput } from '../agent-chat-composer-view';
import {
    agentChatReferenceAttachments,
    draftAfterEditCancel,
    readAgentChatDraft,
} from '../agent-chat-drafts';
import type { AgentChatEdit } from '../agent-chat-edit';
import {
    agentChatEditRemovedTurns,
    agentChatEditSendAction,
    readAgentChatEdit,
    writeAgentChatEdit,
} from '../agent-chat-edit';
import type { AgentChatEditBarProperties as AgentChatEditBarProperties } from '../agent-chat-edit-bar';
import { agentChatEscapeAction, agentChatSendAction } from '../agent-chat-presentation';
import type { useAgentChatAttachments } from './use-agent-chat-attachments';
import type { useAgentChatSubmit } from './use-agent-chat-submit';

export interface AgentChatComposerEditHandle {
    startEdit: (itemId: string, text: string) => void;
}

/**
 * What the Chat pane gives the composer for "Edit from here".
 */
export interface AgentChatComposerEditOptions {
    /**
     * Receives `startEdit`, which a message's "Edit from here" calls.
     */
    handleReference: RefObject<AgentChatComposerEditHandle | null>;
    /**
     * Why "Edit from here" cannot revert files with this provider (`capabilities.chatRewindFiles`), or `undefined`.
     */
    filesUnsupportedReason: string | undefined;
    /**
     * Reports the message being edited, so the timeline can mark it.
     */
    onEditingChange: (itemId: string | undefined) => void;
}

/**
 * The composer's "Edit from here" state: which earlier message is being edited, how many turns sending replaces, and
 * the draft Cancel puts back. The edit survives switching Sessions (`agent-chat-edit`), and ends by itself once the
 * Chat no longer holds its message (it was reset, or restarted onto other history).
 */
export function useAgentChatComposerEdit({
    attachments,
    canSend,
    draft,
    focusInput,
    inputReference,
    isBusy,
    isTurnRunning,
    options,
    providerName,
    snapshot,
    submitEdit,
    terminalId,
    setDraft,
}: {
    /**
     * Takes the edited message's file and folder cards back, and removes them again when the edit is cancelled.
     */
    attachments: Pick<ReturnType<typeof useAgentChatAttachments>, 'addCards' | 'removeCards'>;
    canSend: boolean;
    draft: string;
    focusInput: () => void;
    inputReference: RefObject<AgentChatComposerInput | null>;
    isBusy: boolean;
    isTurnRunning: boolean;
    options: AgentChatComposerEditOptions;
    providerName: string;
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'planMode' | 'turns'> | undefined;
    submitEdit: ReturnType<typeof useAgentChatSubmit>['submitEdit'];
    terminalId: string;
    setDraft: (update: (current: string) => string) => void;
}) {
    const { t } = useTranslation();
    const [edit, setEditState] = useState(() => readAgentChatEdit(terminalId));
    const setEdit = (next: AgentChatEdit | undefined): void => {
        writeAgentChatEdit(terminalId, next);
        setEditState(next);
        options.onEditingChange(next?.itemId);
    };
    /**
     * The edit as stored now. A turn review comment added to the Chat during the edit extends the stored edit's
     * `appendedDraft` (`appendToAgentChatDraft`) without re-rendering this composer, so Cancel and every rewrite of the
     * edit start from the stored one rather than from this hook's state.
     */
    const storedEdit = (current: AgentChatEdit): AgentChatEdit =>
        readAgentChatEdit(terminalId) ?? current;
    const removedTurns = edit && snapshot ? agentChatEditRemovedTurns(snapshot, edit) : undefined;
    const active = edit && removedTurns !== undefined ? { ...edit, removedTurns } : undefined;
    /**
     * The cards the edit brought back, which Cancel removes. Kept for this mount only: an edit restored after a remount
     * leaves its cards for the user to remove.
     */
    const editPathIds = useRef<string[]>([]);
    const startEdit = (itemId: string, message: string): void => {
        const { text, ...cited } = parseAgentChatPathReferences(message);
        attachments.removeCards(editPathIds.current);
        editPathIds.current = attachments.addCards(agentChatReferenceAttachments(cited));
        setDraft(() => text);
        setEdit({
            itemId,
            restoreFiles: active?.restoreFiles ?? false,
            // Switching to another message keeps the draft from before the first edit, plus anything appended to the
            // message being left, since the new message's text replaces it unsent.
            previousDraft: active ? draftAfterEditCancel(storedEdit(active)) : draft,
            appendedDraft: '',
        });
        requestAnimationFrame(() => {
            const input = inputReference.current;
            input?.focus();
            input?.setSelectionRange(text.length, text.length);
        });
    };
    useImperativeHandle(options.handleReference, () => ({ startEdit }));
    const cancel = (): void => {
        if (!active) return;
        attachments.removeCards(editPathIds.current);
        editPathIds.current = [];
        setDraft(() => draftAfterEditCancel(storedEdit(active)));
        setEdit(undefined);
        focusInput();
    };
    const { filesUnsupportedReason } = options;
    const escapeAction = agentChatEscapeAction(
        { key: 'Escape', isComposing: false, repeat: false },
        { isTurnRunning, isEditing: true },
    );
    const bar: AgentChatEditBarProperties | undefined = active && {
        cancelShortcut: escapeAction === 'cancelEdit' ? 'escape' : undefined,
        filesUnsupportedReason,
        removedTurns: active.removedTurns,
        shouldRestoreFiles: active.restoreFiles,
        onCancel: cancel,
        onRestoreFilesChange: (restoreFiles) => {
            const { itemId, previousDraft, appendedDraft } = storedEdit(active);
            setEdit({ itemId, previousDraft, appendedDraft, restoreFiles });
            focusInput();
        },
    };
    return {
        isEditing: active !== undefined,
        /**
         * The edit bar's props while an edit is in progress.
         */
        bar,
        /**
         * The Send button: "Send edit" while editing, and a planning placeholder while plan mode is on.
         */
        sendAction: active
            ? agentChatEditSendAction(isTurnRunning, providerName, t)
            : agentChatSendAction(
                  { isTurnRunning, isBusy, isPlanMode: snapshot?.planMode === true },
                  providerName,
                  t,
              ),
        /**
         * Whether Send is available as far as the Chat goes (`canSend`). A provider rewinds only a settled
         * conversation, so an edit also waits for the running turn to end or be stopped.
         */
        canSend: canSend && !(active && isTurnRunning),
        /**
         * Puts the draft from before the edit back, with anything appended to the Chat's message meanwhile, and ends
         * it.
         */
        cancel,
        /**
         * Sends `text` as the edit, or through `sendMessage` as a new message when no edit is in progress. The edit
         * ends as soon as it is on its way, like a sent message leaves the composer; if Server Core refuses it, the
         * edit comes back with `text`, and Cancel then puts back the draft the composer held at that point.
         */
        submit: async (text: string, sendMessage: () => Promise<void>): Promise<void> => {
            if (!active) return sendMessage();
            const restoreFiles = active.restoreFiles && filesUnsupportedReason === undefined;
            return submitEdit(
                text,
                { ...active, restoreFiles, providerName },
                {
                    onCleared: () => setEdit(undefined),
                    onReturned: () => {
                        setEdit({
                            itemId: active.itemId,
                            restoreFiles: active.restoreFiles,
                            previousDraft: readAgentChatDraft(terminalId),
                            appendedDraft: '',
                        });
                        setDraft(() => text);
                    },
                },
            );
        },
    };
}
