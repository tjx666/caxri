import type { AgentChatQueuedMessage, AgentChatQueueEntry } from '@caxri/protocol';
import { agentChatQueueEntry } from '@caxri/protocol';

import { translate } from '../../i18n';

/**
 * One queued follow-up as its card renders it: the row every Client shares, plus Desktop's Edit.
 */
export interface AgentChatQueueEntryView extends AgentChatQueueEntry {
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
    return (queue ?? []).map((message) => {
        const imageCount = message.imageCount ?? 0;
        return {
            ...agentChatQueueEntry(message, isTurnRunning),
            // The shared row names its images in English for the phone; Desktop names them in the active language.
            imageLabel:
                imageCount === 0
                    ? undefined
                    : imageCount === 1
                      ? translate('agentChat.queue.imageCountOne')
                      : translate('agentChat.queue.imageCountOther', { count: imageCount }),
            canEdit: imageCount === 0,
            editText: message.text,
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
