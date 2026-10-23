import { useState } from 'react';

import { defaultAppSettings } from '@caxri/protocol';

import { translate } from '../../../i18n';
import { useSettings } from '../../../stores/selectors';
import { pushToast, tryCommand } from '../../../stores/toasts';
import { longPasteFailureMessage } from '../../terminal/terminal-long-paste';
import { saveAgentChatLongPaste } from '../agent-chat-commands';
import type {
    AgentChatComposerInput,
    AgentChatComposerPasteEvent,
} from '../composer/agent-chat-composer-view';
import {
    agentChatPasteDisposition,
    canAgentChatPasteFitAsText,
    draftWithPlainPaste,
} from '../composer-input/agent-chat-long-paste';
import { rememberAgentChatSavedPaste } from '../composer-input/agent-chat-long-paste-commands';

/**
 * Where a saved paste's reference goes: the selection the paste replaced, as long as the input still holds `value`.
 */
export interface AgentChatPasteRange {
    end: number;
    start: number;
    value: string;
}

/**
 * Turns a long text paste into a saved file the message cites (`agentChatPasteDisposition`). The text never enters the
 * input; once the Server wrote the file, its reference is inserted where the paste was, and an info notice says so.
 * When the text would have fit the message, the notice offers Paste as Text, which swaps the reference back for the
 * text (`pasteAgentChatSavedPasteAsText`), so the conversion is never silent or one-way. While a save is in flight the
 * composer refuses to send, so Enter cannot send the message without the paste it is waiting for. Cmd+Shift+V
 * (`pastePlainText`) pastes the clipboard as text without the conversion, up to the message limit.
 */
export function useAgentChatLongPaste({
    insert,
    inputReference,
    setDraft,
    terminalId,
}: {
    insert: (text: string, range: AgentChatPasteRange) => void;
    inputReference: { current: AgentChatComposerInput | null };
    setDraft: (update: (current: string) => string) => void;
    terminalId: string;
}) {
    const [savingCount, setSavingCount] = useState(0);
    const threshold = (useSettings() ?? defaultAppSettings)['agentChat.longPasteThreshold'];
    const save = async (
        content: string,
        range: AgentChatPasteRange,
        canFitAsText: boolean,
    ): Promise<void> => {
        setSavingCount((count) => count + 1);
        const reference = await saveAgentChatLongPaste(terminalId, content);
        setSavingCount((count) => count - 1);
        if (!reference) return;
        insert(reference, range);
        pushToast('info', translate('agentChat.composer.longPasteSaved'), {
            ...(canFitAsText && {
                action: {
                    id: 'agentChat.pasteAsText',
                    params: {
                        pasteId: rememberAgentChatSavedPaste({
                            reference,
                            terminalId,
                            text: content,
                        }),
                    },
                },
            }),
        });
    };
    /**
     * Pastes the clipboard's text over the selection exactly as copied, bypassing the long-paste file. A text the
     * message cannot hold is refused with a notice rather than cut.
     */
    const pastePlainText = async (): Promise<void> => {
        const text = await tryCommand(translate('agentChat.composer.plainPasteFailed'), () =>
            navigator.clipboard.readText(),
        );
        const input = inputReference.current;
        if (!text || !input) return;
        const pasted = draftWithPlainPaste(
            input.value,
            input.selectionStart,
            input.selectionEnd,
            text,
        );
        if (!pasted) {
            pushToast('error', translate('agentChat.composer.plainPasteTooLong'));
            return;
        }
        setDraft(() => pasted.draft);
        requestAnimationFrame(() => input.setSelectionRange(pasted.caret, pasted.caret));
    };
    return {
        isSaving: savingCount > 0,
        /**
         * Call first from the input's paste handler. Returns whether the paste's text was taken, so it must not also
         * land in the input; images the same paste carries are still the caller's.
         */
        didTakePaste: (event: AgentChatComposerPasteEvent): boolean => {
            const pasted = event.clipboardData.getData('text/plain');
            const { selectionEnd, selectionStart, value } = event.currentTarget;
            const sizes = {
                currentLength: value.length,
                pasted,
                selectedLength: selectionEnd - selectionStart,
            };
            const disposition = agentChatPasteDisposition({ ...sizes, threshold });
            if (disposition === 'inline') return false;
            event.preventDefault();
            if (disposition === 'too-large')
                pushToast('error', longPasteFailureMessage('too-large'));
            else if (disposition === 'no-room')
                pushToast('error', translate('agentChat.composer.pasteNoRoom'));
            else
                void save(
                    pasted,
                    { end: selectionEnd, start: selectionStart, value },
                    canAgentChatPasteFitAsText(sizes),
                );
            return true;
        },
        pastePlainText,
    };
}
