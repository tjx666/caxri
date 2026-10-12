import type { AgentChatQueuedMessage } from './agent-chat-contract.js';

/**
 * One queued follow-up as the queue card's row names it, on Desktop and on the phone. Editing is a Desktop-only
 * addition on top of this, since the phone holds a bounded preview rather than the message.
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
}

export function agentChatQueueEntry(
    message: AgentChatQueuedMessage,
    isTurnRunning: boolean,
): AgentChatQueueEntry {
    const imageCount = message.imageCount ?? 0;
    return {
        id: message.id,
        preview: (message.command ? (message.command.arguments ?? '') : message.text)
            .replaceAll(/\s+/gu, ' ')
            .trim(),
        commandLabel: message.command && `/${message.command.name}`,
        imageLabel:
            imageCount === 0 ? undefined : imageCount === 1 ? '1 image' : `${imageCount} images`,
        sendNowLabel: isTurnRunning ? 'Steer' : 'Send now',
        canSendNow: !(isTurnRunning && message.command),
    };
}
