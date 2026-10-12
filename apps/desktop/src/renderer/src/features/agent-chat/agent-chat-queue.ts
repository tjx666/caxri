import type { AgentChatQueuedMessage, AgentChatQueueEntry } from '@caxri/protocol';
import { agentChatQueueEntry } from '@caxri/protocol';

import { translate } from '../../i18n';
import type { AgentChatPendingMessage } from './agent-chat-pending';

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
    /**
     * A message still on its way to Server Core (`agent-chat-pending.ts`): shown at the end of the queue it will join,
     * with every action held until Server Core lists it.
     */
    isPending?: true;
}

/**
 * The queue as the card lists it: Server Core's entries, then the messages still on their way to it.
 */
export function agentChatQueueEntries(
    queue: readonly AgentChatQueuedMessage[] | undefined,
    isTurnRunning: boolean,
    pending: readonly AgentChatPendingMessage[] = [],
): AgentChatQueueEntryView[] {
    const pendingEntries = pending.map((message) => ({
        ...queueEntryView(
            { id: message.id, text: message.text, imageCount: message.images.length },
            isTurnRunning,
        ),
        canEdit: false,
        canSendNow: false,
        isPending: true as const,
    }));
    return [
        ...(queue ?? []).map((message) => queueEntryView(message, isTurnRunning)),
        ...pendingEntries,
    ];
}

function queueEntryView(
    message: AgentChatQueuedMessage,
    isTurnRunning: boolean,
): AgentChatQueueEntryView {
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
}
