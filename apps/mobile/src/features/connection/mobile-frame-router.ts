import type {
    MobileEventPayload,
    MobileStreamPayload,
    MobileSubscriptionResource,
} from '@caxri/mobile-transport';
import { mobileEventPayloadSchema, mobileStreamPayloadSchema } from '@caxri/mobile-transport';
import type { CommandReplyEnvelope } from '@caxri/protocol';
import { commandReplyEnvelopeSchema } from '@caxri/protocol';

export type MobileSubscriptionMessage = MobileEventPayload | MobileStreamPayload;
export type MobileSubscriptionListener = (message: MobileSubscriptionMessage) => void;

interface PendingReply {
    reject(error: Error): void;
    resolve(reply: CommandReplyEnvelope): void;
    timeout: ReturnType<typeof setTimeout>;
}

interface ActiveSubscription {
    listener: MobileSubscriptionListener;
    nextSequence: number;
    resource: MobileSubscriptionResource;
}

const isMessageForResource = (
    resource: MobileSubscriptionResource,
    message: MobileSubscriptionMessage,
): boolean => {
    if (message.kind === 'resync-required') return true;
    if (resource.kind === 'dashboard') return message.kind === 'dashboard.changed';
    if (resource.kind === 'conversation') return message.kind === 'conversation.changed';
    return message.kind === 'terminal.snapshot' || message.kind === 'terminal.output';
};

/**
 * Owns request correlation and per-subscription order below React and the WebSocket lifecycle.
 */
export class MobileFrameRouter {
    readonly #pending = new Map<string, PendingReply>();
    readonly #pendingSubscriptionRequests = new Set<string>();
    readonly #preAckMessages = new Map<string, MobileSubscriptionMessage[]>();
    readonly #retiredSubscriptionIds = new Set<string>();
    readonly #subscriptions = new Map<string, ActiveSubscription>();
    #preAckMessageCount = 0;

    #rememberRetired(subscriptionId: string): void {
        this.#retiredSubscriptionIds.add(subscriptionId);
        if (this.#retiredSubscriptionIds.size <= 64) return;
        const oldest = this.#retiredSubscriptionIds.values().next().value;
        if (oldest) this.#retiredSubscriptionIds.delete(oldest);
    }

    beginSubscriptionRequest(id: string): void {
        if (this.#pendingSubscriptionRequests.size > 0)
            throw new Error('Another mobile subscription is awaiting acknowledgement.');
        if (this.#pendingSubscriptionRequests.has(id))
            throw new Error('Mobile subscription request ID was reused.');
        this.#pendingSubscriptionRequests.add(id);
    }

    endSubscriptionRequest(id: string): void {
        this.#pendingSubscriptionRequests.delete(id);
        if (this.#pendingSubscriptionRequests.size > 0) return;
        this.#preAckMessages.clear();
        this.#preAckMessageCount = 0;
    }

    waitForReply(
        id: string,
        timeoutMs: number,
        onTimeout: () => void,
        timeoutError = new Error('Caxri did not respond in time.'),
    ): Promise<CommandReplyEnvelope> {
        if (this.#pending.has(id)) throw new Error('Mobile request ID was reused.');
        if (this.#pending.size >= 32) throw new Error('Too many mobile requests are in flight.');
        return new Promise<CommandReplyEnvelope>((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (!this.#pending.delete(id)) return;
                reject(timeoutError);
                onTimeout();
            }, timeoutMs);
            this.#pending.set(id, { reject, resolve, timeout });
        });
    }

    receiveReply(raw: unknown): void {
        const reply = commandReplyEnvelopeSchema.parse(raw);
        if (reply.id === null) throw new Error('Caxri returned a reply without an ID.');
        const pending = this.#pending.get(reply.id);
        if (!pending) throw new Error('Caxri returned an unexpected reply.');
        this.#pending.delete(reply.id);
        clearTimeout(pending.timeout);
        pending.resolve(reply);
    }

    rejectReply(id: string, error: Error): void {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(error);
    }

    rejectAll(error: Error): void {
        for (const id of this.#pending.keys()) this.rejectReply(id, error);
        this.#pendingSubscriptionRequests.clear();
        this.#preAckMessages.clear();
        this.#preAckMessageCount = 0;
        this.#retiredSubscriptionIds.clear();
        this.#subscriptions.clear();
    }

    addSubscription(
        subscriptionId: string,
        resource: MobileSubscriptionResource,
        listener: MobileSubscriptionListener,
    ): void {
        if (this.#subscriptions.has(subscriptionId))
            throw new Error('Caxri reused a mobile subscription ID.');
        if (this.#retiredSubscriptionIds.has(subscriptionId))
            throw new Error('Caxri reused a retired mobile subscription ID.');
        if (this.#subscriptions.size >= 32)
            throw new Error('Too many mobile subscriptions are active.');
        this.#subscriptions.set(subscriptionId, { listener, nextSequence: 0, resource });
        const earlyMessages = this.#preAckMessages.get(subscriptionId) ?? [];
        this.#preAckMessages.delete(subscriptionId);
        this.#preAckMessageCount -= earlyMessages.length;
        for (const message of earlyMessages) this.receiveSubscriptionMessage(message);
    }

    removeSubscription(subscriptionId: string): void {
        this.#subscriptions.delete(subscriptionId);
        this.#rememberRetired(subscriptionId);
    }

    hasSubscription(subscriptionId: string): boolean {
        return this.#subscriptions.has(subscriptionId);
    }

    receiveSubscriptionMessage(raw: MobileSubscriptionMessage): void {
        const message =
            raw.type === 'event'
                ? mobileEventPayloadSchema.parse(raw)
                : mobileStreamPayloadSchema.parse(raw);
        const subscription = this.#subscriptions.get(message.subscriptionId);
        if (!subscription) {
            if (this.#retiredSubscriptionIds.has(message.subscriptionId)) return;
            if (this.#pendingSubscriptionRequests.size === 0)
                throw new Error('Caxri sent an unexpected subscription message.');
            if (this.#preAckMessageCount >= 32)
                throw new Error('Caxri exceeded the pre-ACK subscription message limit.');
            const messages = this.#preAckMessages.get(message.subscriptionId) ?? [];
            messages.push(message);
            this.#preAckMessages.set(message.subscriptionId, messages);
            this.#preAckMessageCount += 1;
            return;
        }
        if (!isMessageForResource(subscription.resource, message))
            throw new Error('Caxri sent a mobile subscription message for the wrong resource.');
        if (message.sequence !== subscription.nextSequence)
            throw new Error('Caxri mobile subscription sequence changed.');
        subscription.nextSequence += 1;
        if (message.kind === 'resync-required') this.removeSubscription(message.subscriptionId);
        subscription.listener(message);
    }
}
