import type { AgentChatQueuedMessage } from './agent-chat-contract.js';
import { agentChatPathReferencePreview } from './agent-chat-path-references.js';

/**
 * One queued follow-up as the queue card's row names it, on Desktop and on the phone.
 */
export interface AgentChatQueueEntry {
    id: string;
    /**
     * The message text, or a command's arguments; the command itself is `commandLabel`. Whitespace is collapsed so a
     * one- or two-line row shows words, not blank lines.
     */
    preview: string;
    commandLabel: string | undefined;
    /**
     * `1 image` or `3 images` when the message carries images.
     */
    imageLabel: string | undefined;
    /**
     * `Steer` while a turn runs, because sending now joins that turn; `Send now` when the Chat is idle (a paused
     * queue).
     */
    sendNowLabel: 'Send now' | 'Steer';
    /**
     * A command cannot join a running turn, so it waits for its own.
     */
    canSendNow: boolean;
    /**
     * Images stay on Server Core and never come back to a composer, so a message carrying them is deleted or sent, not
     * edited, rather than silently losing its images. Edit takes the full text from `agentChat.takeQueued`, since the
     * phone's queue holds only a preview.
     */
    canEdit: boolean;
}

export function agentChatQueueEntry(
    message: AgentChatQueuedMessage,
    isTurnRunning: boolean,
): AgentChatQueueEntry {
    const imageCount = message.imageCount ?? 0;
    return {
        id: message.id,
        preview: (message.command
            ? (message.command.arguments ?? '')
            : agentChatPathReferencePreview(message.text)
        )
            .replaceAll(/\s+/gu, ' ')
            .trim(),
        commandLabel: message.command && `/${message.command.name}`,
        imageLabel:
            imageCount === 0 ? undefined : imageCount === 1 ? '1 image' : `${imageCount} images`,
        sendNowLabel: isTurnRunning ? 'Steer' : 'Send now',
        canSendNow: !(isTurnRunning && message.command),
        canEdit: imageCount === 0,
    };
}
