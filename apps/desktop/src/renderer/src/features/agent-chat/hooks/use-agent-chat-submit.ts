import { useState } from 'react';

import type { AgentChatCommand } from '@caxri/protocol';

import { didRunAgentChatCommand, didSendAgentChatMessage } from '../agent-chat-commands';
import type { AgentChatAttachment } from '../agent-chat-drafts';
import { draftAfterSend } from '../agent-chat-drafts';
import { parseAgentChatCommand } from '../agent-chat-slash-commands';

/**
 * Sends the draft as a message with its images, or runs it when it names a listed slash command. Only what was actually
 * sent is cleared, so text typed or images attached while a send is in flight survive it.
 */
export function useAgentChatSubmit({
    attachments,
    clearSent,
    commands,
    setDraft,
    terminalId,
}: {
    attachments: readonly AgentChatAttachment[];
    clearSent: (sent: readonly AgentChatAttachment[]) => void;
    commands: readonly AgentChatCommand[] | undefined;
    setDraft: (update: (current: string) => string) => void;
    terminalId: string;
}) {
    const [isSending, setSending] = useState(false);
    const send = async (didDeliver: () => Promise<boolean>, onSent: () => void): Promise<void> => {
        setSending(true);
        try {
            if (await didDeliver()) onSent();
        } finally {
            setSending(false);
        }
    };
    const runCommand = (sent: string, command: { name: string; arguments?: string }) =>
        send(
            () => didRunAgentChatCommand(terminalId, command),
            () => setDraft((current) => draftAfterSend(current, sent)),
        );
    const submit = (sent: string): Promise<void> => {
        const command = parseAgentChatCommand(sent, commands);
        if (command) return runCommand(sent, command);
        const sentAttachments = attachments;
        return send(
            () =>
                didSendAgentChatMessage(terminalId, {
                    text: sent,
                    ...(sentAttachments.length > 0 && {
                        images: sentAttachments.map((attachment) => attachment.image),
                    }),
                }),
            () => {
                setDraft((current) => draftAfterSend(current, sent));
                clearSent(sentAttachments);
            },
        );
    };
    return { isSending, runCommand, submit };
}
