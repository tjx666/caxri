import type { ClipboardEvent } from 'react';
import { useState } from 'react';

import { pushToast } from '../../../stores/toasts';
import { longPasteFailureMessage } from '../../terminal/terminal-long-paste';
import { saveAgentChatLongPaste } from '../agent-chat-commands';
import { agentChatPasteDisposition } from '../agent-chat-long-paste';

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
 * input; once the Server wrote the file, its reference is inserted where the paste was. While a save is in flight the
 * composer refuses to send, so Enter cannot send the message without the paste it is waiting for.
 */
export function useAgentChatLongPaste({
    insert,
    terminalId,
}: {
    insert: (text: string, range: AgentChatPasteRange) => void;
    terminalId: string;
}) {
    const [savingCount, setSavingCount] = useState(0);
    const save = async (content: string, range: AgentChatPasteRange): Promise<void> => {
        setSavingCount((count) => count + 1);
        const reference = await saveAgentChatLongPaste(terminalId, content);
        setSavingCount((count) => count - 1);
        if (reference) insert(reference, range);
    };
    return {
        isSaving: savingCount > 0,
        /**
         * Call first from the input's paste handler. Returns whether the paste's text was taken, so it must not also
         * land in the input; images the same paste carries are still the caller's.
         */
        didTakePaste: (event: ClipboardEvent<HTMLTextAreaElement>): boolean => {
            const pasted = event.clipboardData.getData('text/plain');
            const { selectionEnd, selectionStart, value } = event.currentTarget;
            const disposition = agentChatPasteDisposition({
                currentLength: value.length,
                pasted,
                selectedLength: selectionEnd - selectionStart,
            });
            if (disposition === 'inline') return false;
            event.preventDefault();
            if (disposition === 'too-large')
                pushToast('error', longPasteFailureMessage('too-large'));
            else if (disposition === 'no-room')
                pushToast(
                    'error',
                    'This message is too long to cite pasted text. Your clipboard is unchanged; shorten the message and paste again.',
                );
            // eslint-disable-next-line no-void -- saveAgentChatLongPaste reports its own failures through tryCommand
            else void save(pasted, { end: selectionEnd, start: selectionStart, value });
            return true;
        },
    };
}
