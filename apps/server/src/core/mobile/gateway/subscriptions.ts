import { Buffer } from 'node:buffer';

import type {
    MobileEventPayload,
    MobileStreamPayload,
    MobileSubscriptionResource,
} from '@caxri/mobile-transport';
import {
    MOBILE_GATEWAY_MAX_WIRE_BYTES,
    MOBILE_STREAM_CHUNK_MAX_BYTES,
} from '@caxri/mobile-transport';
import type { Principal, ServerEvent } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

const MAXIMUM_SUBSCRIPTIONS = 32;
const MAXIMUM_PENDING_FRAMES = 32;
const MAXIMUM_PENDING_BYTES = MOBILE_GATEWAY_MAX_WIRE_BYTES * 8;
const MAXIMUM_CONNECTION_PENDING_BYTES = MOBILE_GATEWAY_MAX_WIRE_BYTES * 16;

interface Subscription {
    active: boolean;
    id: string;
    pendingBytes: number;
    pendingFrames: number;
    resource: MobileSubscriptionResource;
    sequence: number;
    tail: Promise<void>;
}

type PushPayload = MobileEventPayload | MobileStreamPayload;

export interface MobileSubscriptionOptions {
    authorize: (principal: Principal, resource: MobileSubscriptionResource) => Promise<void>;
    currentPrincipal: () => Principal;
    matches: (
        principal: Principal,
        resource: MobileSubscriptionResource,
        event: ServerEvent,
    ) => Promise<boolean>;
    randomId: () => string;
    send: (payload: PushPayload) => Promise<void>;
    terminate: () => void;
}

/**
 * Owns one socket's subscriptions and isolates each subscription's output budget.
 */
/* eslint-disable unicorn/consistent-class-member-order -- Public subscription lifecycle precedes queue internals. */
export class MobileGatewaySubscriptions {
    readonly #options: MobileSubscriptionOptions;
    readonly #subscriptions = new Map<string, Subscription>();
    #closed = false;
    #pendingBytes = 0;

    constructor(options: MobileSubscriptionOptions) {
        this.#options = options;
    }

    async subscribe(resource: MobileSubscriptionResource): Promise<string> {
        this.#assertOpen();
        if (this.#subscriptions.size >= MAXIMUM_SUBSCRIPTIONS)
            throw new CaxriError('CAPACITY', 'Too many mobile subscriptions');
        await this.#options.authorize(this.#options.currentPrincipal(), resource);
        this.#assertOpen();
        if (this.#subscriptions.size >= MAXIMUM_SUBSCRIPTIONS)
            throw new CaxriError('CAPACITY', 'Too many mobile subscriptions');
        const id = this.#options.randomId();
        if (this.#subscriptions.has(id))
            throw new CaxriError('INTERNAL', 'Mobile subscription identity collided');
        this.#subscriptions.set(id, {
            active: true,
            id,
            pendingBytes: 0,
            pendingFrames: 0,
            resource,
            sequence: 0,
            tail: Promise.resolve(),
        });
        return id;
    }

    unsubscribe(id: string): void {
        const subscription = this.#subscriptions.get(id);
        if (!subscription) return;
        subscription.active = false;
        this.#subscriptions.delete(id);
    }

    close(): void {
        this.#closed = true;
        for (const subscription of this.#subscriptions.values()) subscription.active = false;
        this.#subscriptions.clear();
    }

    publish(event: ServerEvent): void {
        if (this.#closed) return;
        for (const subscription of this.#subscriptions.values()) {
            const resource = subscription.resource;
            if (resource.kind === 'dashboard' && event.event === 'state.changed')
                this.#queue(subscription, event, 'dashboard.changed');
            else if (resource.kind === 'conversation' && event.event === 'agentTranscript.changed')
                this.#queue(subscription, event, 'conversation.changed');
            else if (
                resource.kind === 'terminal' &&
                event.event === 'terminal.output' &&
                event.payload.terminalId === resource.terminalId
            ) {
                if (event.payload.droppedBytes) {
                    this.#overflow(subscription);
                    continue;
                }
                const bytes = Buffer.from(event.payload.data, 'utf8');
                for (
                    let offset = 0;
                    offset < bytes.length && subscription.active;
                    offset += MOBILE_STREAM_CHUNK_MAX_BYTES
                ) {
                    this.#queue(
                        subscription,
                        event,
                        bytes
                            .subarray(offset, offset + MOBILE_STREAM_CHUNK_MAX_BYTES)
                            .toString('hex'),
                    );
                }
            }
        }
    }

    #queue(subscription: Subscription, event: ServerEvent, kindOrChunk: string): void {
        if (!this.#isActive(subscription)) return;
        const estimatedBytes = kindOrChunk.length + 256;
        if (
            subscription.pendingFrames >= MAXIMUM_PENDING_FRAMES ||
            subscription.pendingBytes + estimatedBytes > MAXIMUM_PENDING_BYTES ||
            this.#pendingBytes + estimatedBytes > MAXIMUM_CONNECTION_PENDING_BYTES
        ) {
            this.#overflow(subscription);
            return;
        }
        subscription.pendingFrames += 1;
        subscription.pendingBytes += estimatedBytes;
        this.#pendingBytes += estimatedBytes;
        subscription.tail = this.#sendQueued(
            subscription.tail,
            subscription,
            event,
            kindOrChunk,
            estimatedBytes,
        );
    }

    async #sendQueued(
        previous: Promise<void>,
        subscription: Subscription,
        event: ServerEvent,
        kindOrChunk: string,
        estimatedBytes: number,
    ): Promise<void> {
        try {
            await previous;
            if (!this.#isActive(subscription)) return;
            const principal = this.#options.currentPrincipal();
            if (!(await this.#options.matches(principal, subscription.resource, event))) return;
            if (!this.#isActive(subscription)) return;
            const sequence = subscription.sequence++;
            const payload: PushPayload =
                event.event === 'terminal.output'
                    ? {
                          type: 'stream',
                          subscriptionId: subscription.id,
                          sequence,
                          kind: 'terminal.output',
                          chunkHex: kindOrChunk,
                      }
                    : {
                          type: 'event',
                          subscriptionId: subscription.id,
                          sequence,
                          kind: kindOrChunk as 'dashboard.changed' | 'conversation.changed',
                      };
            await this.#options.send(payload);
        } catch {
            this.#options.terminate();
        } finally {
            subscription.pendingFrames -= 1;
            subscription.pendingBytes -= estimatedBytes;
            this.#pendingBytes -= estimatedBytes;
        }
    }

    #overflow(subscription: Subscription): void {
        if (!subscription.active || this.#closed) return;
        this.unsubscribe(subscription.id);
        const payload: MobileEventPayload = {
            type: 'event',
            subscriptionId: subscription.id,
            sequence: subscription.sequence++,
            kind: 'resync-required',
            reason: 'capacity',
        };
        // eslint-disable-next-line no-void -- Resync send handles its own failure and runs independently of other subscriptions.
        void this.#sendResync(subscription, payload);
    }

    #assertOpen(): void {
        if (this.#closed) throw new CaxriError('UNAVAILABLE', 'Mobile connection is closed');
    }

    #isActive(subscription: Subscription): boolean {
        return subscription.active && !this.#closed;
    }

    async #sendResync(subscription: Subscription, payload: MobileEventPayload): Promise<void> {
        try {
            await this.#options.authorize(this.#options.currentPrincipal(), subscription.resource);
            if (!this.#closed) await this.#options.send(payload);
        } catch {
            this.#options.terminate();
        }
    }
}
/* eslint-enable unicorn/consistent-class-member-order */
