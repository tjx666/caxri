import type { MobileEventPayload, MobileSubscriptionResource } from '@caxri/mobile-transport';
import { MOBILE_GATEWAY_MAX_WIRE_BYTES } from '@caxri/mobile-transport';
import type { ServerEvent } from '@caxri/protocol';
import { assertNever, CaxriError, clipAgentChatPatchForMobile } from '@caxri/protocol';

import type { TerminalObserverEvent } from '../../../domains/terminal';
import type {
    MobileSubscriptionOptions,
    PushPayload,
    QueuedBody,
    Subscription,
} from './subscription-types';
import { MobileTerminalObserver } from './terminal-observer';

const MAXIMUM_SUBSCRIPTIONS = 32;
const MAXIMUM_TERMINAL_SUBSCRIPTIONS = 4;
const MAXIMUM_PENDING_FRAMES = 32;
const MAXIMUM_PENDING_BYTES = MOBILE_GATEWAY_MAX_WIRE_BYTES * 8;
const MAXIMUM_CONNECTION_PENDING_BYTES = MOBILE_GATEWAY_MAX_WIRE_BYTES * 16;

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
        /**
         * Registered before the asynchronous authorization, while the frame is still being dispatched, so a read the
         * phone sent right after this subscribe cannot observe a change this subscription then misses; such a change
         * becomes a re-read hint on activation. A Terminal stream keeps its own ordering through its observer.
         */
        const early = resource.kind === 'terminal' ? undefined : this.#register(resource);
        try {
            await this.#options.authorize(this.#options.currentPrincipal(), resource);
            this.#assertOpen();
        } catch (error) {
            if (early) this.unsubscribe(early.id);
            throw error;
        }
        if (early && !early.active) throw new CaxriError('CANCELLED', 'Mobile subscription closed');
        if (early) early.authorized = true;
        if (!early && this.#subscriptions.size >= MAXIMUM_SUBSCRIPTIONS)
            throw new CaxriError('CAPACITY', 'Too many mobile subscriptions');
        if (resource.kind === 'terminal') {
            let terminalCount = 0;
            for (const item of this.#subscriptions.values()) {
                if (item.resource.kind !== 'terminal') continue;
                terminalCount += 1;
                if (item.resource.terminalId === resource.terminalId)
                    throw new CaxriError(
                        'CONFLICT',
                        'Terminal already subscribed on this connection',
                    );
            }
            if (terminalCount >= MAXIMUM_TERMINAL_SUBSCRIPTIONS)
                throw new CaxriError('CAPACITY', 'Too many Terminal subscriptions');
        }
        const subscription = early ?? this.#register(resource);
        const { id } = subscription;
        if (resource.kind === 'agentChat' && this.#options.agentChatProjectRoot) {
            // The first lookup holds the same token a later refresh would replace, so a `workbench.changed` that arrives
            // while it is pending wins even when this slower lookup returns last.
            const initial = Symbol('agentChatRootRefresh');
            subscription.agentChatRootRefresh = initial;
            try {
                const root = await this.#options.agentChatProjectRoot(
                    this.#options.currentPrincipal(),
                    resource.terminalId,
                );
                if (subscription.agentChatRootRefresh === initial) {
                    subscription.agentChatProjectRoot = root;
                    subscription.agentChatRootRefresh = undefined;
                }
            } catch (error) {
                this.unsubscribe(id);
                throw error;
            }
        }
        if (resource.kind === 'conversation' && this.#options.beginConversation) {
            try {
                subscription.closeWatch = await this.#options.beginConversation(
                    this.#options.currentPrincipal(),
                    resource.sessionId,
                );
                if (!subscription.active) {
                    subscription.closeWatch();
                    throw new CaxriError('CANCELLED', 'Conversation subscription closed');
                }
            } catch (error) {
                this.unsubscribe(id);
                throw error;
            }
        }
        if (resource.kind === 'agentChat' && this.#options.beginAgentChat) {
            try {
                subscription.closeWatch = await this.#options.beginAgentChat(
                    this.#options.currentPrincipal(),
                    resource.terminalId,
                );
                if (!subscription.active) {
                    subscription.closeWatch();
                    throw new CaxriError('CANCELLED', 'Agent Chat subscription closed');
                }
            } catch (error) {
                this.unsubscribe(id);
                throw error;
            }
        }
        if (resource.kind === 'terminal') {
            const port = this.#options.terminalExecution;
            if (!port) {
                this.unsubscribe(id);
                throw new CaxriError('UNAVAILABLE', 'Terminal observer is unavailable');
            }
            subscription.terminal = new MobileTerminalObserver({
                terminalId: resource.terminalId,
                subscriptionId: id,
                holderId: `${this.#options.connectionId}:${id}`,
                port,
                authorize: () =>
                    this.#options.authorize(this.#options.currentPrincipal(), resource),
                reserve: (bytes) => this.#reserve(subscription, bytes),
                release: (bytes) => this.#release(subscription, bytes),
                send: this.#options.send,
                reportResync: this.#options.reportTerminalResync,
                reportTeardownFailure: this.#options.reportTerminalTeardownFailure,
                reportHumanSteer: this.#options.reportHumanSteer,
                remove: () => this.unsubscribe(id),
                terminate: this.#options.terminate,
            });
            try {
                await subscription.terminal.start();
                await this.#options.authorize(this.#options.currentPrincipal(), resource);
                if (!subscription.active)
                    throw new CaxriError('CANCELLED', 'Terminal subscription closed');
            } catch (error) {
                this.unsubscribe(id);
                throw error;
            }
        }
        return id;
    }

    activate(id: string): void {
        const subscription = this.#subscriptions.get(id);
        if (!subscription) return;
        subscription.activated = true;
        subscription.terminal?.activate();
        const { missed } = subscription;
        subscription.missed = undefined;
        if (missed) this.#queue(subscription, missed.event, missed.body);
    }

    #register(resource: MobileSubscriptionResource): Subscription {
        const id = this.#options.randomId();
        if (this.#subscriptions.has(id))
            throw new CaxriError('INTERNAL', 'Mobile subscription identity collided');
        const subscription: Subscription = {
            active: true,
            activated: false,
            authorized: resource.kind === 'terminal',
            id,
            pendingBytes: 0,
            pendingFrames: 0,
            resource,
            sequence: 0,
            tail: Promise.resolve(),
        };
        this.#subscriptions.set(id, subscription);
        return subscription;
    }

    /**
     * Sends a change to an activated subscription, or remembers it as the re-read hint `activate` sends.
     */
    #deliver(subscription: Subscription, event: ServerEvent, body: QueuedBody): void {
        if (
            subscription.activated ||
            (subscription.authorized && subscription.resource.kind === 'dashboard')
        ) {
            this.#queue(subscription, event, body);
            return;
        }
        subscription.missed = {
            event,
            body: body.kind === 'agentChat.patch' ? { kind: 'agentChat.changed' } : body,
        };
    }

    publishObserverEvent(event: TerminalObserverEvent): void {
        if (this.#closed) return;
        for (const subscription of this.#subscriptions.values())
            subscription.terminal?.accept(event);
    }

    invalidateTerminal(terminalId: string): void {
        for (const subscription of this.#subscriptions.values())
            if (
                subscription.resource.kind === 'terminal' &&
                subscription.resource.terminalId === terminalId
            )
                subscription.terminal?.invalidate();
    }

    terminal(id: string, terminalId: string): MobileTerminalObserver {
        const subscription = this.#subscriptions.get(id);
        if (
            !subscription?.active ||
            subscription.resource.kind !== 'terminal' ||
            subscription.resource.terminalId !== terminalId ||
            !subscription.terminal
        )
            throw new CaxriError('NOT_FOUND', 'Terminal subscription not found');
        return subscription.terminal;
    }

    renewLeases(): void {
        for (const subscription of this.#subscriptions.values())
            if (subscription.terminal) void subscription.terminal.renewLease();
    }

    abortPendingTerminalInputs(): void {
        for (const subscription of this.#subscriptions.values())
            subscription.terminal?.abortPendingInputs();
    }

    unsubscribe(id: string): void {
        const subscription = this.#subscriptions.get(id);
        if (!subscription) return;
        subscription.active = false;
        this.#subscriptions.delete(id);
        subscription.closeWatch?.();
        if (subscription.terminal) void subscription.terminal.close();
    }

    close(): void {
        this.#closed = true;
        for (const subscription of this.#subscriptions.values()) {
            subscription.active = false;
            subscription.closeWatch?.();
            if (subscription.terminal) void subscription.terminal.close();
        }
        this.#subscriptions.clear();
    }

    /**
     * Whether an authorized, still-open subscription follows `sessionId`'s extension views.
     */
    watchesExtensionViews(sessionId: string): boolean {
        if (this.#closed) return false;
        for (const subscription of this.#subscriptions.values())
            if (
                subscription.active &&
                subscription.authorized &&
                subscription.resource.kind === 'extensionViews' &&
                subscription.resource.sessionId === sessionId
            )
                return true;
        return false;
    }

    /**
     * Whether the phone acknowledged a `deviceActions` subscription that is still open.
     */
    acceptsDeviceActions(): boolean {
        return this.#deviceActionSubscription() !== undefined;
    }

    /**
     * Pushes one action on the `deviceActions` subscription, after anything already queued on it. Returns false when
     * the phone is not listening, so the caller fails at once instead of waiting for an answer that cannot come.
     */
    deliverDeviceAction(request: unknown): boolean {
        const subscription = this.#deviceActionSubscription();
        if (!subscription) return false;
        subscription.tail = (async (previous: Promise<void>): Promise<void> => {
            try {
                await previous;
                if (!this.#isActive(subscription)) return;
                const sequence = subscription.sequence++;
                const kind = 'deviceAction.requested';
                await this.#options.send({
                    type: 'event',
                    subscriptionId: subscription.id,
                    sequence,
                    kind,
                    request,
                });
            } catch {
                this.#options.terminate('sendFailed');
            }
        })(subscription.tail);
        return true;
    }

    #deviceActionSubscription(): Subscription | undefined {
        return this.#subscriptions
            .values()
            .find(
                (item) =>
                    this.#isActive(item) &&
                    item.activated &&
                    item.resource.kind === 'deviceActions',
            );
    }

    publish(event: ServerEvent): void {
        if (this.#closed) return;
        const changedSessionIds =
            event.event === 'git.changed' ? new Set(event.payload.sessionIds) : undefined;
        for (const subscription of this.#subscriptions.values())
            this.#publishSubscription(subscription, event, changedSessionIds);
    }

    #publishSubscription(
        subscription: Subscription,
        event: ServerEvent,
        changedSessionIds: Set<string> | undefined,
    ): void {
        const resource = subscription.resource;
        switch (resource.kind) {
            case 'dashboard': {
                if (
                    event.event === 'state.changed' ||
                    event.event === 'sessionPullRequests.changed'
                )
                    this.#deliver(subscription, event, { kind: 'dashboard.changed' });
                break;
            }
            case 'conversation': {
                if (event.event === 'agentTranscript.changed')
                    this.#deliver(subscription, event, { kind: 'conversation.changed' });
                break;
            }
            case 'changes': {
                if (changedSessionIds?.has(resource.sessionId))
                    this.#deliver(subscription, event, { kind: 'changes.changed' });
                break;
            }
            case 'extensionViews': {
                if (
                    event.event === 'viewContainers.treeChanged' &&
                    event.payload.context.kind === 'session' &&
                    event.payload.context.sessionId === resource.sessionId
                )
                    this.#deliver(subscription, event, { kind: 'extensionViews.changed' });
                break;
            }
            case 'agentChat': {
                if (event.event === 'workbench.changed') {
                    this.#refreshAgentChatProjectRoot(subscription, resource.terminalId);
                    break;
                }
                if (
                    event.event === 'agentChat.patch' &&
                    event.payload.terminalId === resource.terminalId
                ) {
                    const patch = subscription.agentChatRootRefresh
                        ? undefined
                        : clipAgentChatPatchForMobile(
                              event.payload,
                              subscription.agentChatProjectRoot,
                          );
                    this.#deliver(
                        subscription,
                        event,
                        patch ? { kind: 'agentChat.patch', patch } : { kind: 'agentChat.changed' },
                    );
                }
                break;
            }
            case 'botInbox': {
                if (event.event === 'botInbox.changed')
                    this.#deliver(subscription, event, { kind: 'botInbox.changed' });
                break;
            }
            case 'terminal':
            case 'deviceActions': {
                break;
            }
            default: {
                assertNever(resource, 'Unhandled mobile subscription publisher');
            }
        }
    }

    #reserve(subscription: Subscription, bytes: number): boolean {
        if (
            !this.#isActive(subscription) ||
            subscription.pendingBytes + bytes > MAXIMUM_PENDING_BYTES ||
            this.#pendingBytes + bytes > MAXIMUM_CONNECTION_PENDING_BYTES
        )
            return false;
        subscription.pendingBytes += bytes;
        this.#pendingBytes += bytes;
        return true;
    }

    /**
     * `workbench.changed` names a Session, not a Terminal, so every Chat subscription resolves its root again; the
     * lookup is one database read per subscription and there are at most a handful per connection.
     */
    #refreshAgentChatProjectRoot(subscription: Subscription, terminalId: string): void {
        const resolveRoot = this.#options.agentChatProjectRoot;
        if (!resolveRoot || !this.#isActive(subscription)) return;
        const refresh = Symbol('agentChatRootRefresh');
        subscription.agentChatRootRefresh = refresh;
        void this.#applyAgentChatProjectRoot(subscription, terminalId, resolveRoot, refresh);
    }

    /**
     * Applies the resolved root only while `refresh` is still the latest request, so a slower earlier lookup never
     * overwrites a newer one.
     */
    async #applyAgentChatProjectRoot(
        subscription: Subscription,
        terminalId: string,
        resolveRoot: NonNullable<MobileSubscriptionOptions['agentChatProjectRoot']>,
        refresh: symbol,
    ): Promise<void> {
        try {
            const root = await resolveRoot(this.#options.currentPrincipal(), terminalId);
            if (subscription.agentChatRootRefresh === refresh)
                subscription.agentChatProjectRoot = root;
        } catch {
            // Keep the previous root: a lost grant ends the subscription through authorization, not here.
        } finally {
            if (subscription.agentChatRootRefresh === refresh)
                subscription.agentChatRootRefresh = undefined;
        }
    }

    #release(subscription: Subscription, bytes: number): void {
        subscription.pendingBytes -= bytes;
        this.#pendingBytes -= bytes;
    }

    #queue(subscription: Subscription, event: ServerEvent, body: QueuedBody): void {
        if (!this.#isActive(subscription)) return;
        const estimatedBytes = JSON.stringify(body).length + 256;
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
            body,
            estimatedBytes,
        );
    }

    async #sendQueued(
        previous: Promise<void>,
        subscription: Subscription,
        event: ServerEvent,
        body: QueuedBody,
        estimatedBytes: number,
    ): Promise<void> {
        try {
            await previous;
            if (!this.#isActive(subscription)) return;
            const principal = this.#options.currentPrincipal();
            if (!(await this.#options.matches(principal, subscription.resource, event))) return;
            if (!this.#isActive(subscription)) return;
            const sequence = subscription.sequence++;
            const payload: PushPayload = {
                type: 'event',
                subscriptionId: subscription.id,
                sequence,
                ...body,
            };
            await this.#options.send(payload);
        } catch {
            this.#options.terminate('sendFailed');
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
            this.#options.terminate('sendFailed');
        }
    }
}
/* eslint-enable unicorn/consistent-class-member-order */
