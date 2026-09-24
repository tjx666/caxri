import type { MobileServerPayload, MobileSubscriptionResource } from '@caxri/mobile-transport';
import {
    mobileClientPayloadSchema,
    mobileSubscribeResultSchema,
    mobileUnsubscribeResultSchema,
} from '@caxri/mobile-transport';
import type {
    CommandDispatcher,
    CommandExecutionContext,
    CommandReplyEnvelope,
    Principal,
    ServerEvent,
} from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    commandReplyEnvelopeSchema,
    requestEnvelopeSchema,
    toWireError,
} from '@caxri/protocol';

import { boundedMobileReply, forbiddenMobileReply } from './reply';
import { MobileGatewaySubscriptions } from './subscriptions';

const MAXIMUM_ACTIVE_OPERATIONS = 8;
const HEARTBEAT_CHECK_MS = 3_000;
const HEARTBEAT_IDLE_MS = 12_000;

interface MobileAppOptions {
    authorizeMethod: (principal: Principal, method: string) => void;
    authorizeSubscription: (
        principal: Principal,
        resource: MobileSubscriptionResource,
    ) => Promise<void>;
    context: () => CommandExecutionContext;
    dispatch: CommandDispatcher;
    isActive: () => boolean;
    matchesSubscriptionEvent: (
        principal: Principal,
        resource: MobileSubscriptionResource,
        event: ServerEvent,
    ) => Promise<boolean>;
    now: () => number;
    randomSubscriptionId: () => string;
    send: (payload: MobileServerPayload) => Promise<void>;
    terminate: () => void;
}

/**
 * Routes authenticated frames without allowing one slow command to block heartbeat or another reply.
 */
/* eslint-disable unicorn/consistent-class-member-order -- Public lifecycle methods precede frame routing internals. */
export class MobileGatewayFrameRouter {
    readonly #activeIds = new Set<string>();
    readonly #options: MobileAppOptions;
    readonly #subscriptions: MobileGatewaySubscriptions;
    readonly #timer: ReturnType<typeof setInterval>;
    #closed = false;
    #lastClientFrameAt: number;

    constructor(options: MobileAppOptions) {
        this.#options = options;
        this.#lastClientFrameAt = options.now();
        this.#subscriptions = new MobileGatewaySubscriptions({
            authorize: options.authorizeSubscription,
            currentPrincipal: () => options.context().principal,
            matches: options.matchesSubscriptionEvent,
            randomId: options.randomSubscriptionId,
            send: options.send,
            terminate: options.terminate,
        });
        this.#timer = setInterval(() => {
            if (this.#options.now() - this.#lastClientFrameAt >= HEARTBEAT_IDLE_MS)
                this.#options.terminate();
        }, HEARTBEAT_CHECK_MS);
        this.#timer.unref();
    }

    close(): void {
        this.#closed = true;
        clearInterval(this.#timer);
        this.#subscriptions.close();
    }

    publish(event: ServerEvent): void {
        if (!this.#closed) this.#subscriptions.publish(event);
    }

    accept(raw: unknown): void {
        if (this.#closed || !this.#options.isActive()) return;
        const payload = mobileClientPayloadSchema.parse(raw);
        this.#lastClientFrameAt = this.#options.now();
        switch (payload.type) {
            case 'heartbeat': {
                // eslint-disable-next-line no-void -- An acknowledgement must not block the inbound frame reader.
                void this.#acknowledgeHeartbeat(payload.nonce);
                return;
            }
            case 'request': {
                const request = requestEnvelopeSchema.parse(payload.request);
                this.#run(request.id, async () => {
                    const context = this.#options.context();
                    try {
                        this.#options.authorizeMethod(context.principal, request.method);
                    } catch (error) {
                        if (error instanceof CaxriError && error.code === 'FORBIDDEN')
                            return forbiddenMobileReply(request);
                        throw error;
                    }
                    const reply = await this.#options.dispatch(request, context);
                    this.#options.authorizeMethod(
                        this.#options.context().principal,
                        request.method,
                    );
                    return boundedMobileReply(request, commandReplyEnvelopeSchema.parse(reply));
                });
                return;
            }
            case 'subscribe': {
                this.#run(payload.id, async () => {
                    const subscriptionId = await this.#subscriptions.subscribe(payload.resource);
                    try {
                        await this.#options.authorizeSubscription(
                            this.#options.context().principal,
                            payload.resource,
                        );
                    } catch (error) {
                        this.#subscriptions.unsubscribe(subscriptionId);
                        throw error;
                    }
                    return successReply(
                        payload.id,
                        mobileSubscribeResultSchema.parse({ subscriptionId }),
                    );
                });
                return;
            }
            case 'unsubscribe': {
                this.#run(payload.id, () => {
                    this.#options.context();
                    this.#subscriptions.unsubscribe(payload.subscriptionId);
                    return successReply(payload.id, mobileUnsubscribeResultSchema.parse({}));
                });
            }
        }
    }

    #run(id: string, action: () => Promise<CommandReplyEnvelope> | CommandReplyEnvelope): void {
        if (this.#activeIds.has(id)) {
            this.#options.terminate();
            return;
        }
        if (this.#activeIds.size >= MAXIMUM_ACTIVE_OPERATIONS) {
            if (this.#options.isActive())
                // eslint-disable-next-line no-void -- Capacity replies are independently sent on the authenticated socket.
                void this.#reply(
                    errorReply(id, new CaxriError('CAPACITY', 'Too many mobile operations')),
                );
            return;
        }
        this.#activeIds.add(id);
        // eslint-disable-next-line no-void -- Operations complete independently so one slow command cannot block another frame.
        void (async (): Promise<void> => {
            try {
                let reply: CommandReplyEnvelope;
                try {
                    reply = await action();
                } catch (error) {
                    reply = errorReply(id, error);
                }
                if (!this.#closed && this.#options.isActive()) {
                    try {
                        this.#options.context();
                        await this.#reply(reply);
                    } catch {
                        this.#options.terminate();
                    }
                }
            } finally {
                this.#activeIds.delete(id);
            }
        })();
    }

    async #acknowledgeHeartbeat(nonce: string): Promise<void> {
        try {
            await this.#options.send({ type: 'heartbeat-ack', nonce });
        } catch {
            this.#options.terminate();
        }
    }

    async #reply(reply: CommandReplyEnvelope): Promise<void> {
        try {
            await this.#options.send({ type: 'reply', reply });
        } catch {
            this.#options.terminate();
        }
    }
}
/* eslint-enable unicorn/consistent-class-member-order */

function successReply(id: string, result: unknown): CommandReplyEnvelope {
    return { protocolVersion: CAXRI_PROTOCOL_VERSION, id, ok: true, result };
}

function errorReply(id: string, error: unknown): CommandReplyEnvelope {
    return { protocolVersion: CAXRI_PROTOCOL_VERSION, id, ok: false, error: toWireError(error) };
}
