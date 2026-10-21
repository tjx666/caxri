import { useTranslation } from '../../../i18n';
import { isImeComposing } from '../../../lib/ime';
import { sendAgentChatQueuedNow } from '../agent-chat-commands';
import {
    agentChatComposerKeyAction,
    isAgentChatClearKey,
    isAgentChatPlainPasteKey,
} from '../composer/agent-chat-composer-keys';
import {
    agentChatListContinuation,
    isAgentChatListContinuationKey,
} from '../composer/agent-chat-composer-list';
import type { AgentChatComposerKeyEvent } from '../composer/agent-chat-composer-view';
import type { agentChatSendTooltip } from '../transcript/agent-chat-presentation';
import { agentChatSendRefusal } from '../transcript/agent-chat-presentation';
import { useAgentChatComposerNotice } from './use-agent-chat-composer-notice';

/**
 * The composer's Enter and Escape once no suggestion list or prompt history claimed the key
 * (`agentChatComposerKeyAction`): Escape stops the turn or cancels an edit, Enter in an empty input sends the next
 * queued message, and Enter on a draft submits it. A draft the composer cannot send yet says why in the strip
 * (`agentChatSendRefusal`) instead of doing nothing; `notice` carries that line. Cmd+Shift+V pastes the clipboard as
 * plain text (`pastePlainText`), skipping the long-paste conversion; no suggestion list or history claims it. Ctrl+C
 * with no selection empties a composer that holds text or attachments (`isAgentChatClearKey`); over a selection it
 * stays Copy. The text goes as an edit, so Cmd+Z brings it back. Shift+Enter on a Markdown list line starts the next
 * item (`agentChatListContinuation`).
 */
export function useAgentChatComposerEnter({
    cancelEdit,
    clearAttachments,
    hasPendingQueue,
    isBusy,
    isEditing,
    isSendable,
    isTurnRunning,
    nextQueuedId,
    pastePlainText,
    sendAction,
    sendState,
    stop,
    submit,
    terminalId,
}: {
    cancelEdit: () => void;
    /**
     * Removes every attachment, for Ctrl+C.
     */
    clearAttachments: () => void;
    /**
     * Whether a message is still on its way into the queue, which keeps Enter from sending an older entry.
     */
    hasPendingQueue: boolean;
    isBusy: boolean;
    isEditing: boolean;
    isSendable: boolean;
    isTurnRunning: boolean;
    /**
     * The queued message an empty composer's Enter sends now (`agentChatNextQueuedId`).
     */
    nextQueuedId: string | undefined;
    pastePlainText: () => Promise<void>;
    sendAction: Parameters<typeof agentChatSendTooltip>[0];
    sendState: Parameters<typeof agentChatSendTooltip>[1];
    stop: () => void;
    submit: (delivery?: 'steer') => Promise<void>;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const refusalNotice = useAgentChatComposerNotice();
    const submitFromKey = (delivery: 'steer' | undefined): void => {
        const refusal = agentChatSendRefusal(sendAction, { ...sendState, isSendable }, t);
        if (refusal) refusalNotice.show(refusal);
        // eslint-disable-next-line no-void -- submit reports its own failures through tryCommand
        else void submit(delivery);
    };
    const onKeyDown = (event: AgentChatComposerKeyEvent): void => {
        if (isAgentChatPlainPasteKey(event)) {
            event.preventDefault();
            // eslint-disable-next-line no-void -- pastePlainText reports its own failures
            void pastePlainText();
            return;
        }
        const key = {
            key: event.key,
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            isComposing: isImeComposing(event),
            metaKey: event.metaKey,
            repeat: event.repeat,
            shiftKey: event.shiftKey,
        };
        if (isAgentChatClearKey(key)) {
            const input = event.currentTarget;
            // Ctrl+C over a selection stays Copy, which is what it means on Windows and Linux.
            if (input.selectionStart !== input.selectionEnd) return;
            // A whitespace-only draft counts too: Ctrl+C should leave the input visibly empty.
            if (!sendState.hasContent && input.value === '') return;
            event.preventDefault();
            input.applyEdit({ from: 0, to: input.value.length, text: '', caret: 0 });
            clearAttachments();
            return;
        }
        if (isAgentChatListContinuationKey(key)) {
            const input = event.currentTarget;
            const edit = agentChatListContinuation(
                input.value,
                input.selectionStart,
                input.selectionEnd,
            );
            if (edit) {
                event.preventDefault();
                input.applyEdit(edit);
            }
            return;
        }
        const action = agentChatComposerKeyAction(key, {
            isBusy,
            isEditing,
            isTurnRunning,
            nextQueuedId:
                isEditing || hasPendingQueue || sendState.hasContent || sendState.isSending
                    ? undefined
                    : nextQueuedId,
        });
        if (!action) return;
        event.preventDefault();
        switch (action.kind) {
            case 'stop': {
                stop();
                break;
            }
            case 'cancelEdit': {
                cancelEdit();
                break;
            }
            case 'sendQueued': {
                sendAgentChatQueuedNow(terminalId, action.id);
                break;
            }
            default: {
                submitFromKey(action.delivery);
            }
        }
    };
    return { notice: refusalNotice.notice, onKeyDown };
}
