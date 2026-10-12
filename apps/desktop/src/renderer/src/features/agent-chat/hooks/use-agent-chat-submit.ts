import { useState } from 'react';

import type { AgentChatCommand } from '@caxri/protocol';

import { cachedAgentChatSnapshot } from '../agent-chat-client';
import {
    didRewindAgentChat,
    didRunAgentChatCommand,
    didSendAgentChatMessage,
} from '../agent-chat-commands';
import type { AgentChatAttachment } from '../agent-chat-drafts';
import { draftAfterSend, returnUnsentAgentChatMessage } from '../agent-chat-drafts';
import {
    dropAgentChatPendingMessage,
    expireAgentChatPendingMessage,
    showAgentChatPendingMessage,
} from '../agent-chat-pending';
import { parseAgentChatCommand } from '../agent-chat-slash-commands';

/**
 * Sends the draft as a message with its images, or runs it when it names a listed slash command. A message leaves the
 * composer at once and shows as pending where it will land (`agent-chat-pending.ts`); a failed send takes the pending
 * row away and puts its text and images back. A command, an edit, and a rewind still wait for Server Core, and clear
 * only what was actually sent, so text typed or images attached while they are in flight survive them.
 */
export function useAgentChatSubmit({
    attachments,
    clearSent,
    commands,
    onSent,
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
    setDraft: (update: (current: string) => string) => void;
    terminalId: string;
}) {
    const [isSending, setSending] = useState(false);
    const send = async (
        didDeliver: () => Promise<boolean>,
        clearDelivered: () => void,
    ): Promise<void> => {
        setSending(true);
        try {
            if (await didDeliver()) {
                clearDelivered();
                onSent?.();
            }
        } finally {
            setSending(false);
        }
    };
    const runCommand = (sent: string, command: { name: string; arguments?: string }) =>
        send(
            () => didRunAgentChatCommand(terminalId, command),
            () => setDraft((current) => draftAfterSend(current, sent)),
        );
    /**
     * `delivery` applies only while a turn runs (see `agentChat.send`); a slash command issued during a turn always
     * waits in the queue, because a command cannot join a running turn.
     */
    const submit = async (sent: string, delivery?: 'queue' | 'steer'): Promise<void> => {
        const command = parseAgentChatCommand(sent, commands);
        if (command) return runCommand(sent, command);
        const sentAttachments = attachments;
        const pendingId = showAgentChatPendingMessage(
            terminalId,
            cachedAgentChatSnapshot(terminalId),
            {
                text: sent,
                images: sentAttachments.map((attachment) => ({
                    thumbnail: attachment.image.thumbnail,
                })),
                delivery,
            },
        );
        setDraft((current) => draftAfterSend(current, sent));
        clearSent(sentAttachments);
        onSent?.();
        const isSent = await didSendAgentChatMessage(
            terminalId,
            {
                text: sent,
                ...(sentAttachments.length > 0 && {
                    images: sentAttachments.map((attachment) => attachment.image),
                }),
            },
            delivery,
        );
        if (isSent) {
            expireAgentChatPendingMessage(terminalId, pendingId);
            return;
        }
        dropAgentChatPendingMessage(terminalId, pendingId);
        returnUnsentAgentChatMessage(terminalId, sent, sentAttachments);
    };
    /**
     * Sends the draft in place of an earlier message ("Edit from here"). It is always sent as a message, never run as a
     * slash command, because it replaces a message. Once delivered, the draft the edit replaced comes back.
     */
    const submitEdit = (
        sent: string,
        edit: {
            itemId: string;
            restoreFiles: boolean;
            previousDraft: string;
            providerName: string;
            removedTurns: number;
        },
        onDone: () => void,
    ): Promise<void> => {
        const sentAttachments = attachments;
        return send(
            () =>
                didRewindAgentChat(terminalId, {
                    itemId: edit.itemId,
                    restoreFiles: edit.restoreFiles,
                    providerName: edit.providerName,
                    removedTurns: edit.removedTurns,
                    message: {
                        text: sent,
                        ...(sentAttachments.length > 0 && {
                            images: sentAttachments.map((attachment) => attachment.image),
                        }),
                    },
                }),
            () => {
                setDraft((current) => (current === sent ? edit.previousDraft : current));
                clearSent(sentAttachments);
                onDone();
            },
        );
    };
    return { isSending, runCommand, submit, submitEdit };
}
