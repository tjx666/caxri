import type { RefObject } from 'react';
import { useImperativeHandle, useState } from 'react';

import type { AgentChatSnapshot } from '@caxri/protocol';

import type { AgentChatEdit } from '../agent-chat-edit';
import {
    agentChatEditRemovedTurns,
    agentChatEditSendAction,
    readAgentChatEdit,
    writeAgentChatEdit,
} from '../agent-chat-edit';
import type { AgentChatEditBarProperties as AgentChatEditBarProperties } from '../agent-chat-edit-bar';
import { agentChatEscapeAction, agentChatSendAction } from '../agent-chat-presentation';
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
    canSend: boolean;
    draft: string;
    focusInput: () => void;
    inputReference: RefObject<HTMLTextAreaElement | null>;
    isBusy: boolean;
    isTurnRunning: boolean;
    options: AgentChatComposerEditOptions;
    providerName: string;
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'planMode' | 'turns'> | undefined;
    submitEdit: ReturnType<typeof useAgentChatSubmit>['submitEdit'];
    terminalId: string;
    setDraft: (update: (current: string) => string) => void;
}) {
    const [edit, setEditState] = useState(() => readAgentChatEdit(terminalId));
    const setEdit = (next: AgentChatEdit | undefined): void => {
        writeAgentChatEdit(terminalId, next);
        setEditState(next);
        options.onEditingChange(next?.itemId);
    };
    const removedTurns = edit && snapshot ? agentChatEditRemovedTurns(snapshot, edit) : undefined;
    const active = edit && removedTurns !== undefined ? { ...edit, removedTurns } : undefined;
    const startEdit = (itemId: string, text: string): void => {
        setDraft(() => text);
        setEdit({
            itemId,
            restoreFiles: active?.restoreFiles ?? false,
            // Switching to another message keeps the draft from before the first edit.
            previousDraft: active ? active.previousDraft : draft,
        });
        requestAnimationFrame(() => {
            const textarea = inputReference.current;
            textarea?.focus();
            textarea?.setSelectionRange(text.length, text.length);
        });
    };
    useImperativeHandle(options.handleReference, () => ({ startEdit }));
    const cancel = (): void => {
        if (!active) return;
        setDraft(() => active.previousDraft);
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
            setEdit({ itemId: active.itemId, previousDraft: active.previousDraft, restoreFiles });
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
            ? agentChatEditSendAction(isTurnRunning, providerName)
            : agentChatSendAction(
                  { isTurnRunning, isBusy, isPlanMode: snapshot?.planMode === true },
                  providerName,
              ),
        /**
         * Whether Send is available as far as the Chat goes (`canSend`). A provider rewinds only a settled
         * conversation, so an edit also waits for the running turn to end or be stopped.
         */
        canSend: canSend && !(active && isTurnRunning),
        /**
         * Puts the draft from before the edit back and ends it.
         */
        cancel,
        /**
         * Sends `text` as the edit, or through `sendMessage` as a new message when no edit is in progress.
         */
        submit: async (text: string, sendMessage: () => Promise<void>): Promise<void> => {
            if (!active) return sendMessage();
            const restoreFiles = active.restoreFiles && filesUnsupportedReason === undefined;
            return submitEdit(text, { ...active, restoreFiles, providerName }, () =>
                setEdit(undefined),
            );
        },
    };
}
