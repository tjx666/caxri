import type { AgentChatQueuedMessage } from '@caxri/protocol';

import { translate } from '../../i18n';

/**
 * One queued follow-up as its card renders it.
 */
export interface AgentChatQueueEntryView {
    id: string;
    /**
     * The message text, or a command's arguments; the command itself is `commandLabel`.
     */
    preview: string;
    commandLabel: string | undefined;
    imageLabel: string | undefined;
    /**
     * `Steer` while a turn runs, because sending now joins that turn; `Send now` when the Chat is idle (a paused
     * queue). An identity, not display text: the card translates it.
     */
    sendNowLabel: 'Send now' | 'Steer';
    /**
     * A command cannot join a running turn, so it waits for its own.
     */
    canSendNow: boolean;
    /**
     * Images stay on Server Core and never come back to the composer, so a message carrying them is deleted or sent,
     * not edited, rather than silently losing its images.
     */
    canEdit: boolean;
    /**
     * What Edit puts back into the composer.
     */
    editText: string;
}

export function agentChatQueueEntries(
    queue: readonly AgentChatQueuedMessage[] | undefined,
    isTurnRunning: boolean,
): AgentChatQueueEntryView[] {
    return (queue ?? []).map((entry) => {
        const imageCount = entry.imageCount ?? 0;
        return {
            id: entry.id,
            preview: entry.command ? (entry.command.arguments ?? '') : entry.text,
            commandLabel: entry.command && `/${entry.command.name}`,
            imageLabel:
                imageCount === 0
                    ? undefined
                    : imageCount === 1
                      ? translate('agentChat.queue.imageCountOne')
                      : translate('agentChat.queue.imageCountOther', { count: imageCount }),
            sendNowLabel: isTurnRunning ? 'Steer' : 'Send now',
            canSendNow: !(isTurnRunning && entry.command),
            canEdit: imageCount === 0,
            editText: entry.text,
        };
    });
}

/**
 * The composer draft after Edit returns a queued message: the message alone when the composer is empty, otherwise the
 * message ahead of what the user had typed, so neither is lost.
 */
export function draftAfterQueueEdit(current: string, edited: string): string {
    if (!current.trim()) return edited;
    return `${edited}\n${current}`;
}
