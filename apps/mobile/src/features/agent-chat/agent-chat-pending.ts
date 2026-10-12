import type {
    AgentChatPendingAnswer,
    AgentChatPendingMessageBase,
    AgentChatRequest,
    AgentChatResponse,
    AgentChatSnapshot,
} from '@caxri/protocol';
import {
    AGENT_CHAT_PENDING_ACCEPTED_TTL_MS,
    agentChatAnsweredNotice,
    agentChatPendingKnownIds,
    agentChatPendingKnownQueueLength,
    agentChatPendingPlacement,
    unsettledAgentChatPendingAnswers,
    unsettledAgentChatPendingMessages,
} from '@caxri/protocol';

import { notifyListeners } from '../../lib/notify-listeners';
import { classifyMobileWriteFailure } from '../connection/mobile-write-failure';
import { agentChatSendFailureMessage } from './agent-chat-model';

/**
 * A message the phone is sending that the Chat's projection does not show yet, as Desktop shows one
 * (`agent-chat-pending.ts` there). The phone previews its images from the prepared JPEGs it still has on disk; the
 * projection's copy only names them.
 */
interface MobileAgentChatPendingMessage extends AgentChatPendingMessageBase {
    imageUris: readonly string[];
}

export interface MobileAgentChatPendingState {
    messages: readonly MobileAgentChatPendingMessage[];
    answers: readonly AgentChatPendingAnswer[];
    /**
     * Counts every message and slash command this phone sent into the Chat, so the timeline can follow the user's own
     * send even when the message lands in the queue rather than at the end of the timeline.
     */
    sendCount: number;
}

const EMPTY: MobileAgentChatPendingState = { messages: [], answers: [], sendCount: 0 };

/**
 * Pending sends and answers per Chat, keyed by pairing scope and Terminal. Module state rather than hook state, because
 * the composer that sends and the timeline and queue that show the result are siblings, and leaving the Session while a
 * send is in flight must not lose its row or the draft it returns on failure.
 */
export class AgentChatPendingStore {
    readonly #states = new Map<string, MobileAgentChatPendingState>();
    readonly #listeners = new Map<string, Set<() => void>>();

    get(key: string): MobileAgentChatPendingState {
        return this.#states.get(key) ?? EMPTY;
    }

    update(
        key: string,
        change: (current: MobileAgentChatPendingState) => MobileAgentChatPendingState,
    ): void {
        const current = this.get(key);
        const next = change(current);
        if (next === current) return;
        if (next.messages.length === 0 && next.answers.length === 0 && next.sendCount === 0)
            this.#states.delete(key);
        else this.#states.set(key, next);
        notifyListeners(this.#listeners.get(key) ?? [], undefined);
    }

    subscribe(key: string, listener: () => void): () => void {
        const listeners = this.#listeners.get(key) ?? new Set<() => void>();
        listeners.add(listener);
        this.#listeners.set(key, listeners);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) this.#listeners.delete(key);
        };
    }

    /**
     * Shows a message the composer is sending, where it is going to land, and returns its id.
     */
    show(
        key: string,
        snapshot: AgentChatSnapshot | undefined,
        message: {
            id: string;
            text: string;
            imageUris: readonly string[];
            delivery: 'steer' | undefined;
        },
    ): string {
        this.update(key, (current) => ({
            ...current,
            messages: [
                ...current.messages,
                {
                    id: message.id,
                    text: message.text,
                    imageUris: message.imageUris,
                    imageCount: message.imageUris.length,
                    placement: agentChatPendingPlacement(
                        snapshot,
                        message.delivery,
                        current.messages.length > 0,
                    ),
                    knownIds: agentChatPendingKnownIds(snapshot),
                    knownQueueLength: agentChatPendingKnownQueueLength(snapshot),
                },
            ],
            sendCount: current.sendCount + 1,
        }));
        return message.id;
    }

    /**
     * Counts a slash command the user ran. It shows nothing optimistically, but its result (such as the compaction
     * notice) lands at the end of the timeline, which must follow it like any other send.
     */
    countCommand(key: string): void {
        this.update(key, (current) => ({ ...current, sendCount: current.sendCount + 1 }));
    }

    dropMessage(key: string, id: string): void {
        this.update(key, (current) =>
            current.messages.some((message) => message.id === id)
                ? { ...current, messages: current.messages.filter((message) => message.id !== id) }
                : current,
        );
    }

    /**
     * Bounds an accepted message's row (`AGENT_CHAT_PENDING_ACCEPTED_TTL_MS`); the projection showing it usually drops
     * the row long before.
     */
    expireMessage(key: string, id: string): void {
        setTimeout(() => this.dropMessage(key, id), AGENT_CHAT_PENDING_ACCEPTED_TTL_MS);
    }

    addAnswer(key: string, answer: AgentChatPendingAnswer): void {
        this.update(key, (current) => ({
            ...current,
            answers: [
                ...current.answers.filter((pending) => pending.requestId !== answer.requestId),
                answer,
            ],
        }));
    }

    dropAnswer(key: string, requestId: string): void {
        this.update(key, (current) =>
            current.answers.some((pending) => pending.requestId === requestId)
                ? {
                      ...current,
                      answers: current.answers.filter((pending) => pending.requestId !== requestId),
                  }
                : current,
        );
    }

    /**
     * Drops what the projection now shows, so the pending rows hand over to the real ones.
     */
    prune(key: string, snapshot: AgentChatSnapshot | undefined): void {
        this.update(key, (current) => {
            const messages = unsettledAgentChatPendingMessages(current.messages, snapshot);
            const answers = unsettledAgentChatPendingAnswers(current.answers, snapshot);
            return messages === current.messages && answers === current.answers
                ? current
                : { ...current, answers, messages };
        });
    }
}

export const agentChatPendingStore = new AgentChatPendingStore();

export const agentChatPendingKey = (scope: string | null, terminalId: string): string =>
    JSON.stringify([scope, terminalId]);

/**
 * Sends a message without waiting for the round trip, as Desktop's composer does: the message shows at once where it
 * lands and the composer clears; a failed send takes the row away, puts the text and images back ahead of anything
 * typed since, and reports why (`agentChatSendFailureMessage`: "not sent" only when the write provably did not happen,
 * otherwise a prompt to check the Chat before sending again). A delivered one stays until the projection shows it,
 * bounded by its TTL.
 */
export const sendAgentChatMessageOptimistically = async ({
    clearComposer,
    key,
    message,
    reportError,
    returnUnsent,
    send,
    snapshot,
    store = agentChatPendingStore,
}: {
    clearComposer: () => void;
    key: string;
    message: {
        id: string;
        text: string;
        imageUris: readonly string[];
        delivery: 'steer' | undefined;
    };
    reportError: (message: string | null) => void;
    returnUnsent: () => void;
    send: () => Promise<void>;
    snapshot: AgentChatSnapshot | undefined;
    store?: AgentChatPendingStore;
}): Promise<void> => {
    reportError(null);
    const id = store.show(key, snapshot, message);
    clearComposer();
    try {
        await send();
    } catch (error) {
        store.dropMessage(key, id);
        returnUnsent();
        reportError(agentChatSendFailureMessage(classifyMobileWriteFailure(error)));
        return;
    }
    store.expireMessage(key, id);
};

/**
 * Answers an approval or question without waiting for the round trip, as Desktop does: the card leaves at once and a
 * question's answers show in the timeline as Server Core will record them. A failed answer brings the card back and
 * rejects, so the card reports it.
 */
export const answerAgentChatRequestOptimistically = async ({
    key,
    request,
    respond,
    response,
    store = agentChatPendingStore,
}: {
    key: string;
    request: AgentChatRequest;
    respond: () => Promise<void>;
    response: AgentChatResponse;
    store?: AgentChatPendingStore;
}): Promise<void> => {
    store.addAnswer(key, {
        requestId: request.id,
        notice:
            response.kind === 'answers'
                ? agentChatAnsweredNotice(request, undefined, response.answers)
                : undefined,
    });
    try {
        await respond();
    } catch (error) {
        store.dropAnswer(key, request.id);
        throw error;
    }
};
