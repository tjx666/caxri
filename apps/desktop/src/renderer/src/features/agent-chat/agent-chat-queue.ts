import type { AgentChatQueuedMessage, AgentChatQueueEntry } from '@caxri/protocol';
import { agentChatQueueEntry } from '@caxri/protocol';

import { translate } from '../../i18n';
import type { AgentChatPendingMessage } from './agent-chat-pending';

/**
 * One queued follow-up as its card renders it: the row every Client shares, plus the messages still on their way.
 */
export interface AgentChatQueueEntryView extends AgentChatQueueEntry {
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

/**
 * The queued message Enter in an empty composer sends now: the head of Server Core's queue, so the shortcut does what
 * the first card's Steer or Send now does. `undefined` when the queue is empty or its head must wait for the turn (a
 * command cannot steer).
 */
export function agentChatNextQueuedId(
    queue: readonly AgentChatQueuedMessage[] | undefined,
    isTurnRunning: boolean,
): string | undefined {
    const head = queue?.at(0);
    return head && agentChatQueueEntry(head, isTurnRunning).canSendNow ? head.id : undefined;
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
    };
}
