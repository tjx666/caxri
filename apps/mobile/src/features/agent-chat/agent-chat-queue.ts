import type { AgentChatSnapshot } from '@caxri/protocol';

import { imageCountLabel } from '../conversation/conversation-model';

export interface AgentChatQueueRow {
    id: string;
    /**
     * One line naming what will be sent: the message text, the slash command it runs, or its image count.
     */
    text: string;
    /**
     * The image count chip beside a message that also has text, or `undefined`.
     */
    images?: string;
}

/**
 * The follow-up queue as the read-only list above the phone's composer, in send order. The Server already cut each
 * message to a preview (`clipAgentChatQueueForMobile`); this only picks the words a row shows.
 */
export const agentChatQueueRows = (
    snapshot: Pick<AgentChatSnapshot, 'queue'> | undefined,
): AgentChatQueueRow[] =>
    (snapshot?.queue ?? []).map((message) => {
        const images = message.imageCount ? imageCountLabel(message.imageCount) : undefined;
        if (message.command)
            return {
                id: message.id,
                text: [`/${message.command.name}`, message.command.arguments]
                    .filter(Boolean)
                    .join(' '),
            };
        const text = message.text.replaceAll(/\s+/gu, ' ').trim();
        if (text.length === 0) return { id: message.id, text: images ?? '' };
        return { id: message.id, text, ...(images && { images }) };
    });

/**
 * The queue's caption. A queue paused by Stop sends nothing until it is resumed, which the phone cannot do yet, so the
 * caption says where to resume it.
 */
export const agentChatQueueCaption = (
    snapshot: Pick<AgentChatSnapshot, 'queue' | 'queuePaused'> | undefined,
): string | undefined => {
    const count = snapshot?.queue?.length ?? 0;
    if (count === 0) return undefined;
    return snapshot?.queuePaused ? 'Queued, paused. Resume on your computer.' : 'Queued';
};
