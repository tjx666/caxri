import type {
    AgentChatQueuedMessage,
    AgentChatQueueEntry,
    AgentChatSnapshot,
} from '@caxri/protocol';
import { agentChatQueueEntry } from '@caxri/protocol';

import type { Translate } from '../../../i18n';
import { translate } from '../../../i18n';
import type { AgentChatPendingMessage } from '../transcript/agent-chat-pending';

/**
 * One queued follow-up as its card renders it: the row every Client shares, plus the messages still on their way.
 */
export interface AgentChatQueueEntryView extends AgentChatQueueEntry {
    /**
     * The message's whole text, which the in-place editor of a message with images starts from.
     */
    text: string;
    /**
     * How many images ride with the message (0 for none).
     */
    imageCount: number;
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
    pending: readonly AgentChatPendingMessage[],
    t: Translate,
): AgentChatQueueEntryView[] {
    const pendingEntries = pending.map((message) => ({
        ...queueEntryView(
            { id: message.id, text: message.text, imageCount: message.images.length },
            isTurnRunning,
            t,
        ),
        canEdit: false,
        canSendNow: false,
        isPending: true as const,
    }));
    return [
        ...(queue ?? []).map((message) => queueEntryView(message, isTurnRunning, t)),
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
    t: Translate,
): AgentChatQueueEntryView {
    const imageCount = message.imageCount ?? 0;
    return {
        ...agentChatQueueEntry(message, isTurnRunning),
        text: message.text,
        imageCount,
        // The shared row names its images in English for the phone; Desktop names them in the active language.
        imageLabel:
            imageCount === 0
                ? undefined
                : imageCount === 1
                  ? t('agentChat.queue.imageCountOne')
                  : t('agentChat.queue.imageCountOther', { count: imageCount }),
    };
}

/**
 * What deleting a queued message does with its text: `restore` moves it back into the composer, so a mis-click is
 * recoverable by clearing the draft; `drop` deletes it outright.
 */
export type AgentChatQueueDeleteOutcome = 'drop' | 'restore';

/**
 * Deleting restores the text only into an empty composer, so a draft the user is writing is never overwritten or merged
 * with a message they meant to discard. A message carrying images is dropped too: its images stay on Server Core and
 * cannot return to the composer, so restoring the text alone would split the message.
 */
export function agentChatQueueDeleteOutcome(
    isDraftEmpty: boolean,
    entry: Pick<AgentChatQueueEntryView, 'imageCount'>,
): AgentChatQueueDeleteOutcome {
    return isDraftEmpty && entry.imageCount === 0 ? 'restore' : 'drop';
}

/**
 * The words on a queue card's actions. A message still on its way to Server Core says so on every action, since all of
 * them are held until Server Core lists it; otherwise each tooltip names the action or why it is unavailable (a command
 * waits for the running turn instead of steering it).
 */
export interface AgentChatQueueCardLabels {
    /**
     * Names what Delete actually does, so a restore into an empty composer is not announced as a deletion.
     */
    deleteAriaLabel: string;
    deleteTooltip: string;
    editTooltip: string;
    sendTooltip: string;
    sendAriaLabel: string;
}

export function agentChatQueueCardLabels(
    entry: Pick<AgentChatQueueEntryView, 'canSendNow' | 'isPending' | 'sendNowLabel'>,
    t: Translate = translate,
    deleteOutcome: AgentChatQueueDeleteOutcome = 'drop',
): AgentChatQueueCardLabels {
    const isSteer = entry.sendNowLabel === 'Steer';
    const sendLabels = {
        deleteAriaLabel: t(
            deleteOutcome === 'restore'
                ? 'agentChat.queue.restoreMessage'
                : 'agentChat.queue.deleteMessage',
        ),
        sendAriaLabel: t(isSteer ? 'agentChat.queue.steerNow' : 'agentChat.queue.sendNow'),
    };
    if (entry.isPending) {
        const sending = t('agentChat.message.sending');
        return {
            deleteTooltip: sending,
            editTooltip: sending,
            sendTooltip: sending,
            ...sendLabels,
        };
    }
    return {
        deleteTooltip: t(
            deleteOutcome === 'restore' ? 'agentChat.queue.deleteRestoreTooltip' : 'common.delete',
        ),
        editTooltip: t('common.edit'),
        sendTooltip: entry.canSendNow
            ? t(isSteer ? 'agentChat.queue.steerTooltip' : 'agentChat.queue.sendNow')
            : t('agentChat.queue.commandWaits'),
        ...sendLabels,
    };
}

/**
 * The queue's header line, shown only while the queue is paused: a waiting queue has none, like the Codex app's, since
 * its rows already read as messages that go next. `tone` picks the glyph and color: `failed` (`--danger`) when Server
 * Core could not send the queued messages it took, and `paused` (`--warning`) after the user's Stop or a send whose
 * delivery is unknown. `resumeLabel` is its action: `Retry` after a failure, since resuming re-sends what failed, and
 * `Resume` otherwise.
 */
export interface AgentChatQueueHeader {
    tone: 'failed' | 'paused';
    text: string;
    resumeLabel: string;
}

export function agentChatQueueHeader(
    snapshot: Pick<AgentChatSnapshot, 'queuePauseReason' | 'queuePaused'> | undefined,
    t: Translate = translate,
): AgentChatQueueHeader | undefined {
    if (!snapshot?.queuePaused) return undefined;
    switch (snapshot.queuePauseReason) {
        case 'sendFailed': {
            return {
                tone: 'failed',
                text: t('agentChat.queue.sendFailed'),
                resumeLabel: t('common.retry'),
            };
        }
        case 'deliveryUnknown': {
            return {
                tone: 'paused',
                text: t('agentChat.queue.pausedDeliveryUnknown'),
                resumeLabel: t('agentChat.queue.resume'),
            };
        }
        case 'usageGuard': {
            return {
                tone: 'paused',
                text: t('agentChat.queue.pausedUsageGuard'),
                resumeLabel: t('agentChat.queue.resume'),
            };
        }
        case 'stopped':
        case undefined: {
            return {
                tone: 'paused',
                text: t('agentChat.queue.paused'),
                resumeLabel: t('agentChat.queue.resume'),
            };
        }
    }
}
