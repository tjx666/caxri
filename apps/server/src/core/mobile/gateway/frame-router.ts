import process from 'node:process';

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

import type { TerminalExecutionPort, TerminalObserverEvent } from '../../../domains/terminal';
import type { MobileTerminalResyncReason } from './diagnostics';
import { boundedMobileReply, forbiddenMobileReply } from './reply';
import { MobileGatewaySubscriptions } from './subscriptions';

const MAXIMUM_ACTIVE_OPERATIONS = 8;
const HEARTBEAT_CHECK_MS = 3_000;
const HEARTBEAT_IDLE_MS = 12_000;
const e2eAckDropState = { didDrop: false };

function shouldDropE2ESubmitAcknowledgement(method: string, isSucceeded: boolean): boolean {
    if (
        method !== 'mobile.agent.submit' ||
        !isSucceeded ||
        e2eAckDropState.didDrop ||
        process.env.CAXRI_E2E !== '1' ||
        process.env.CAXRI_E2E_MOBILE_DROP_SUBMIT_ACK_ONCE !== '1'
    )
        return false;
    e2eAckDropState.didDrop = true;
    return true;
}

export interface MobileAppOptions {
    authorizeMethod: (principal: Principal, method: string) => void;
    authorizeSubscription: (
        principal: Principal,
        resource: MobileSubscriptionResource,
    ) => Promise<void>;
    beginConversationSubscription?: (
        principal: Principal,
        sessionId: string,
    ) => Promise<() => void>;
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
    reportTerminalResync?: (reason: MobileTerminalResyncReason) => void;
    send: (payload: MobileServerPayload) => Promise<void>;
    terminate: () => void;
    terminalExecution?: TerminalExecutionPort;
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
        const connectionId = options.context().connection?.connectionId;
        if (!connectionId) throw new CaxriError('FORBIDDEN', 'Mobile connection is required');
        this.#subscriptions = new MobileGatewaySubscriptions({
            authorize: options.authorizeSubscription,
            beginConversation: options.beginConversationSubscription,
            currentPrincipal: () => options.context().principal,
            matches: options.matchesSubscriptionEvent,
            randomId: options.randomSubscriptionId,
            send: options.send,
            reportTerminalResync: options.reportTerminalResync,
            terminate: options.terminate,
            terminalExecution: options.terminalExecution,
            connectionId,
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

    publishObserverEvent(event: TerminalObserverEvent): void {
        if (!this.#closed) this.#subscriptions.publishObserverEvent(event);
    }

    invalidateTerminal(terminalId: string): void {
        if (!this.#closed) this.#subscriptions.invalidateTerminal(terminalId);
    }

    abortPendingTerminalInputs(): void {
        this.#subscriptions.abortPendingTerminalInputs();
    }

    terminalSubscription(id: string, terminalId: string) {
        if (this.#closed) throw new CaxriError('UNAVAILABLE', 'Mobile connection is closed');
        return this.#subscriptions.terminal(id, terminalId);
    }

    accept(raw: unknown): void {
        if (this.#closed || !this.#options.isActive()) return;
        const payload = mobileClientPayloadSchema.parse(raw);
        this.#lastClientFrameAt = this.#options.now();
        switch (payload.type) {
            case 'heartbeat': {
                this.#subscriptions.renewLeases();
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
                    const bounded = boundedMobileReply(
                        request,
                        commandReplyEnvelopeSchema.parse(reply),
                    );
                    /**
                     * Fixture-only loss after durable Host acceptance, before any reply reaches the device.
                     */
                    if (shouldDropE2ESubmitAcknowledgement(request.method, bounded.ok)) {
                        this.#options.terminate();
                        return;
                    }
                    return bounded;
                });
                return;
            }
            case 'subscribe': {
                let subscriptionId: string | undefined;
                this.#run(
                    payload.id,
                    async () => {
                        subscriptionId = await this.#subscriptions.subscribe(payload.resource);
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
                    },
                    () => {
                        if (subscriptionId) this.#subscriptions.activate(subscriptionId);
                    },
                );
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

    #run(
        id: string,
        action: () => Promise<CommandReplyEnvelope | undefined> | CommandReplyEnvelope | undefined,
        afterReply?: () => void,
    ): void {
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
                let reply: CommandReplyEnvelope | undefined;
                try {
                    reply = await action();
                } catch (error) {
                    reply = errorReply(id, error);
                }
                if (reply && !this.#closed && this.#options.isActive()) {
                    try {
                        this.#options.context();
                        const sent = await this.#reply(reply);
                        if (sent && reply.ok) afterReply?.();
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

    async #reply(reply: CommandReplyEnvelope): Promise<boolean> {
        try {
            await this.#options.send({ type: 'reply', reply });
            return true;
        } catch {
            this.#options.terminate();
            return false;
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
