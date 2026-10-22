import { useState } from 'react';

import type { AgentChatCommand, AgentChatMessageInput } from '@caxri/protocol';
import {
    agentChatTextWithPathReferences,
    agentProviderCatalog,
    parseAgentChatCommand,
} from '@caxri/protocol';

import { awaitThenCleanup } from '../../../lib/await-then-cleanup';
import { useTerminal } from '../../../stores/selectors';
import { cachedAgentChatSnapshot } from '../agent-chat-client';
import {
    didRewindAgentChat,
    didRunAgentChatCommand,
    didSendAgentChatMessage,
} from '../agent-chat-commands';
import { agentChatTextWithSentImageNumbers } from '../attachments/agent-chat-image-placeholders';
import { retainAgentChatSentImageOriginals } from '../attachments/agent-chat-sent-image-originals';
import type { AgentChatAttachment } from '../composer-input/agent-chat-drafts';
import {
    didDeliverAgentChatComposerInput,
    draftAfterSend,
    isAgentChatImageAttachment,
    isAgentChatPathAttachment,
    isAgentChatSkillAttachment,
    returnUnsentAgentChatMessage,
} from '../composer-input/agent-chat-drafts';
import {
    askAgentChatSideQuestion,
    isAgentChatSideChatBusyFor,
} from '../side-chat/agent-chat-side-chat-commands';
import { parseAgentChatSideQuestion } from '../side-chat/agent-chat-side-thread';
import { openAgentChatSideChat } from '../tasks/agent-chat-task-opener';
import {
    dropAgentChatPendingMessage,
    expireAgentChatPendingMessage,
    showAgentChatPendingMessage,
} from '../transcript/agent-chat-pending';

/**
 * The message `text` and `attachments` make: images ride along as images, their placeholders numbered in the order they
 * are sent (`agentChatTextWithSentImageNumbers`), and skill, file, and folder cards are cited ahead of the text in the
 * provider's own layout (`agentChatTextWithPathReferences`).
 */
function agentChatMessageInput(
    text: string,
    attachments: readonly AgentChatAttachment[],
    providerName: string,
): AgentChatMessageInput {
    const imageAttachments = attachments.filter(isAgentChatImageAttachment);
    const images = imageAttachments.map(({ image }) => image);
    return {
        text: agentChatTextWithPathReferences(
            agentChatTextWithSentImageNumbers(text, imageAttachments),
            attachments.filter(isAgentChatPathAttachment),
            providerName,
            attachments.filter(isAgentChatSkillAttachment).map(({ skill }) => ({ name: skill })),
        ),
        ...(images.length > 0 && { images }),
    };
}

/**
 * Sends the draft as a message with its images and file and folder cards, or runs it when it names a listed slash
 * command. A message leaves the composer at once and shows as pending where it will land (`agent-chat-pending.ts`); a
 * failed send takes the pending row away and puts its text and images back. A command and an edit leave the composer at
 * once too, while Send says the composer is sending until Server Core answers, and come back if it refuses them
 * (`didDeliverAgentChatComposerInput`). Each clears only what was actually sent, so text typed or images attached while
 * they are in flight survive them. A `/btw <question>` draft, for a provider with side chats, is asked in the Chat's
 * side chat instead and never reaches the main conversation.
 */
export function useAgentChatSubmit({
    attachments,
    clearSent,
    commands,
    onSent,
    onSideChatBusy,
    providerName,
    setDraft,
    terminalId,
}: {
    attachments: readonly AgentChatAttachment[];
    clearSent: (sent: readonly AgentChatAttachment[]) => void;
    commands: readonly AgentChatCommand[] | undefined;
    /**
     * Runs once a message left the composer, or after Server Core accepted a slash command or an edit; never after a
     * failure of those.
     */
    onSent?: () => void;
    /**
     * Runs when a `/btw` question is held back because the side chat is still answering the previous one; the draft
     * stays in the composer.
     */
    onSideChatBusy?: () => void;
    /**
     * The provider catalog's display name, which heads the user's words after cited files and folders.
     */
    providerName: string;
    setDraft: (update: (current: string) => string) => void;
    terminalId: string;
}) {
    const [isSending, setSending] = useState(false);
    const terminal = useTerminal(terminalId);
    const hasSideChat =
        terminal !== undefined &&
        terminal.kind !== 'shell' &&
        agentProviderCatalog[terminal.kind].capabilities.chatSideQuestion;
    const didDeliver = async (
        delivery: Parameters<typeof didDeliverAgentChatComposerInput>[0],
    ): Promise<boolean> => {
        setSending(true);
        const isDelivered = await awaitThenCleanup(didDeliverAgentChatComposerInput(delivery), () =>
            setSending(false),
        );
        if (isDelivered) onSent?.();
        return isDelivered;
    };
    /**
     * Runs `command`, typed or chosen in the composer as `sent`. A command the composer did not hold (the compact
     * command the context alert runs, `isFromDraft: false`) leaves the draft alone and has nothing to put back.
     * Resolves whether Server Core accepted it.
     */
    const runCommand = (
        sent: string,
        command: { name: string; arguments?: string },
        { isFromDraft = true }: { isFromDraft?: boolean } = {},
    ) =>
        didDeliver({
            clear: () => setDraft((current) => draftAfterSend(current, sent)),
            deliver: (clear) => {
                clear();
                return didRunAgentChatCommand(terminalId, command);
            },
            restore: () => {
                if (isFromDraft) returnUnsentAgentChatMessage(terminalId, sent, []);
            },
        });
    /**
     * `delivery` applies only while a turn runs (see `agentChat.send`); a slash command issued during a turn always
     * waits in the queue, because a command cannot join a running turn.
     */
    const submit = async (sent: string, delivery?: 'queue' | 'steer'): Promise<void> => {
        // `/btw <question>` goes to the side chat, not the main turn, at any time: it never queues or steers.
        const sideQuestion = hasSideChat ? parseAgentChatSideQuestion(sent) : undefined;
        if (sideQuestion) {
            // Checked before the draft clears: `askAgentChatSideQuestion` drops a question asked while one is pending.
            if (isAgentChatSideChatBusyFor(terminalId)) {
                onSideChatBusy?.();
                return;
            }
            setDraft((current) => draftAfterSend(current, sent));
            onSent?.();
            openAgentChatSideChat(terminalId);
            await askAgentChatSideQuestion(terminalId, sideQuestion);
            return;
        }
        const command = parseAgentChatCommand(sent, commands);
        if (command) {
            await runCommand(sent, command);
            return;
        }
        const sentAttachments = attachments;
        const message = agentChatMessageInput(sent, sentAttachments, providerName);
        const snapshot = cachedAgentChatSnapshot(terminalId);
        const pendingId = showAgentChatPendingMessage(terminalId, snapshot, {
            text: message.text,
            images: (message.images ?? []).map(({ thumbnail }) => ({ thumbnail })),
            delivery,
        });
        retainAgentChatSentImageOriginals(message.images ?? []);
        setDraft((current) => draftAfterSend(current, sent));
        clearSent(sentAttachments);
        onSent?.();
        const isSent = await didSendAgentChatMessage(terminalId, message, delivery);
        if (isSent) {
            expireAgentChatPendingMessage(terminalId, pendingId);
            return;
        }
        dropAgentChatPendingMessage(terminalId, pendingId);
        returnUnsentAgentChatMessage(terminalId, sent, sentAttachments);
    };
    /**
     * Sends the draft in place of an earlier message ("Edit from here"). It is always sent as a message, never run as a
     * slash command, because it replaces a message. Once the user confirmed it, the draft the edit replaced comes back
     * and `onCleared` ends the edit; if Server Core then refuses it, its images come back and `onReturned` puts the
     * edit back.
     */
    const submitEdit = async (
        sent: string,
        edit: {
            itemId: string;
            restoreFiles: boolean;
            previousDraft: string;
            providerName: string;
            removedTurns: number;
        },
        { onCleared, onReturned }: { onCleared: () => void; onReturned: () => void },
    ): Promise<void> => {
        const sentAttachments = attachments;
        await didDeliver({
            clear: () => {
                setDraft((current) => (current === sent ? edit.previousDraft : current));
                clearSent(sentAttachments);
                onCleared();
            },
            deliver: (clear) =>
                didRewindAgentChat(
                    terminalId,
                    {
                        itemId: edit.itemId,
                        restoreFiles: edit.restoreFiles,
                        providerName: edit.providerName,
                        removedTurns: edit.removedTurns,
                        message: agentChatMessageInput(sent, sentAttachments, providerName),
                    },
                    clear,
                ),
            restore: () => {
                onReturned();
                returnUnsentAgentChatMessage(terminalId, '', sentAttachments);
            },
        });
    };
    return { isSending, runCommand, submit, submitEdit };
}
