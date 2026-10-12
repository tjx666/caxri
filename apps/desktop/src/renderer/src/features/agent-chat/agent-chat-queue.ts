import type {
    AgentChatQueuedMessage,
    AgentChatQueueEntry,
    AgentChatSnapshot,
} from '@caxri/protocol';
import { agentChatQueueEntry } from '@caxri/protocol';

import type { Translate } from '../../i18n';
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

/**
 * The words on a queue card's actions. A message still on its way to Server Core says so on every action, since all of
 * them are held until Server Core lists it; otherwise each tooltip names the action or why it is unavailable (a message
 * carrying images cannot be edited, and a command waits for the running turn instead of steering it).
 */
export interface AgentChatQueueCardLabels {
    editTooltip: string;
    deleteTooltip: string;
    sendTooltip: string;
    /**
     * The send button's visible text: `Steer` while a turn runs, `Send now` otherwise.
     */
    sendText: string;
    sendAriaLabel: string;
}

export function agentChatQueueCardLabels(
    entry: Pick<AgentChatQueueEntryView, 'canEdit' | 'canSendNow' | 'isPending' | 'sendNowLabel'>,
    t: Translate = translate,
): AgentChatQueueCardLabels {
    const isSteer = entry.sendNowLabel === 'Steer';
    const sendLabels = {
        sendText: t(isSteer ? 'agentChat.queue.steer' : 'agentChat.queue.sendNow'),
        sendAriaLabel: t(isSteer ? 'agentChat.queue.steerNow' : 'agentChat.queue.sendNow'),
    };
    if (entry.isPending) {
        const sending = t('agentChat.message.sending');
        return {
            editTooltip: sending,
            deleteTooltip: sending,
            sendTooltip: sending,
            ...sendLabels,
        };
    }
    return {
        editTooltip: t(entry.canEdit ? 'common.edit' : 'agentChat.edit.imagesUnsupported'),
        deleteTooltip: t('common.delete'),
        sendTooltip: entry.canSendNow
            ? t(isSteer ? 'agentChat.queue.steerTooltip' : 'agentChat.queue.sendNow')
            : t('agentChat.queue.commandWaits'),
        ...sendLabels,
    };
}

/**
 * The queue card's header line. `tone` picks the glyph and color: `failed` (`--danger`) when Server Core could not send
 * the queued messages it took, `paused` (`--warning`) after the user's Stop or a send whose delivery is unknown, and
 * `normal` while the queue simply waits. `resumeLabel` is the header's action, present only while paused: `Retry` after
 * a failure, since resuming re-sends what failed, and `Resume` otherwise.
 */
export interface AgentChatQueueHeader {
    tone: 'failed' | 'normal' | 'paused';
    text: string;
    resumeLabel?: string;
}

export function agentChatQueueHeader(
    snapshot: Pick<AgentChatSnapshot, 'queuePauseReason' | 'queuePaused'> | undefined,
    isTurnRunning: boolean,
    entries: ReadonlyArray<Pick<AgentChatQueueEntryView, 'commandLabel'>>,
    t: Translate = translate,
): AgentChatQueueHeader {
    if (snapshot?.queuePaused) {
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
    if (!isTurnRunning) return { tone: 'normal', text: t('agentChat.queue.queued') };
    /**
     * Server Core joins the run of messages at the head of the queue into one turn; a command keeps a turn of its own,
     * so only two leading messages make "together" true.
     */
    const isJoined =
        entries.length >= 2 &&
        entries[0].commandLabel === undefined &&
        entries[1].commandLabel === undefined;
    return {
        tone: 'normal',
        text: t(
            isJoined
                ? 'agentChat.queue.queuedTogetherAfterTurn'
                : 'agentChat.queue.queuedAfterTurn',
        ),
    };
}
