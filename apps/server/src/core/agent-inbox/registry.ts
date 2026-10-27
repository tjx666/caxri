import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import type {
    AgentEndpointRef as AgentEndpointReference,
    AgentEndpointSummary,
    AgentHeldMessage,
    AgentHeldMessageDetail,
    AgentHeldRetention,
    AgentInboundMessage,
    AgentInboundPolicy,
    AgentMessagePullResult,
    AgentMessageReceipt,
    CommandExecutionContext,
} from '@caxri/protocol';
import { AGENT_MESSAGE_APPROVAL_TTL_MS, CaxriError } from '@caxri/protocol';

import type { AgentEndpointRegistry } from '../agent-endpoints';
import {
    agentMessageDigest,
    areReferencesEqual as referencesEqual,
    decideInboundStatus,
    DUPLICATE_WINDOW_MS,
    endpointKey,
    heldMessageDetail,
    heldMessageProjection,
    LOOP_WINDOW_MS,
    MAX_DUPLICATES,
    MAX_HELD_PER_ENDPOINT,
    MAX_PAIR_MESSAGES_PER_WINDOW,
    MAX_PENDING_BYTES,
    MAX_PENDING_MESSAGES,
    MAX_RECEIPTS,
    MAX_REPLY_DEPTH,
    MAX_WAITING_PER_ENDPOINT,
    PENDING_MESSAGE_STATES,
    pushQueued,
    removeQueued,
    resolvePullReceiver,
    resolveSender,
} from './rules';
import type { AgentMessageTransitionReason } from './transition-log';
import { logMessageTransition } from './transition-log';
import type {
    AgentInboxRegistryOptions,
    AgentMessageSendInput,
    DeliveryReservation,
    DuplicateReceipt,
    IdempotencyReceipt,
    MessageAdmission,
    MessageWaiter,
    StoredMessage,
} from './types';

/**
 * Server Core in-memory Peer Inbox. Bodies never cross into persistence, logs, domain services, or Terminal input.
 */
export class AgentInboxRegistry {
    private readonly duplicates = new Map<string, DuplicateReceipt>();
    private readonly held = new Map<string, string[]>();
    private readonly id: () => string;
    private readonly idempotency = new Map<string, IdempotencyReceipt>();
    private readonly messages = new Map<string, StoredMessage>();
    private readonly now: () => number;
    private readonly pairTraffic = new Map<string, number[]>();
    private readonly policies = new Map<
        string,
        { policy: AgentInboundPolicy; heldRetention: AgentHeldRetention }
    >();
    private readonly reservations = new Map<string, DeliveryReservation>();
    private readonly waiting = new Map<string, string[]>();
    private readonly waiters = new Map<string, MessageWaiter>();
    private pendingBytes = 0;
    private pendingMessages = 0;

    constructor(
        private readonly endpoints: AgentEndpointRegistry,
        private readonly options: AgentInboxRegistryOptions = {},
    ) {
        this.id = options.id ?? randomUUID;
        this.now = options.now ?? Date.now;
        endpoints.onRetired((endpoint) => this.retire(endpoint.ref));
        endpoints.onMessagingChanged((endpoint, previous) => {
            if (
                previous.deliveryMode !== endpoint.messaging.deliveryMode &&
                endpoint.messaging.deliveryMode !== 'pull'
            )
                this.disablePull(endpoint.ref, endpoint.messaging.deliveryMode === 'unavailable');
        });
    }

    private disablePull(reference: AgentEndpointReference, isUnavailable: boolean): void {
        const key = endpointKey(reference);
        const waiter = this.waiters.get(key);
        if (waiter) {
            clearTimeout(waiter.timer);
            this.waiters.delete(key);
            waiter.resolve({ message: null, outcome: 'empty' });
        }
        for (const [requestId, reservation] of this.reservations) {
            if (reservation.endpointKey !== key) continue;
            this.cancelWait(requestId);
        }
        if (!isUnavailable) return;
        for (const message of this.messages.values()) {
            if (
                referencesEqual(message.receipt.to, reference) &&
                PENDING_MESSAGE_STATES.includes(message.state)
            )
                this.finish(message, 'unavailable', 'delivery_disabled');
        }
    }

    private admit(
        context: CommandExecutionContext,
        input: AgentMessageSendInput,
        idempotencyKey: string,
    ): AgentMessageReceipt {
        this.sweep();
        const from = resolveSender(this.endpoints, context);
        if (from.messaging.deliveryMode === 'unavailable')
            throw new CaxriError('UNAVAILABLE', 'Agent Endpoint messaging is unavailable', {
                reason: from.messaging.reason,
                nextAction: from.messaging.nextAction,
            });
        if (referencesEqual(from.ref, input.to))
            throw new CaxriError('VALIDATION', 'An Agent Endpoint cannot message itself');
        const canonicalDigest = agentMessageDigest({
            to: input.to,
            body: input.body,
            replyTo: input.replyTo ?? null,
            ttlMs: input.ttlMs,
            dispatchId: input.dispatchId ?? null,
        });
        const idempotencyMapKey = `${endpointKey(from.ref)}:${idempotencyKey}`;
        const previous = this.idempotency.get(idempotencyMapKey);
        if (previous) {
            if (previous.digest !== canonicalDigest)
                throw new CaxriError(
                    'VALIDATION',
                    'An idempotency key cannot be reused for different message input',
                );
            const message = this.messages.get(previous.messageId);
            if (message) return message.receipt;
            this.idempotency.delete(idempotencyMapKey);
        }

        const fingerprint = agentMessageDigest([
            endpointKey(from.ref),
            endpointKey(input.to),
            input.replyTo ?? null,
            input.body,
        ]);
        const duplicate = this.duplicates.get(fingerprint);
        if (duplicate && duplicate.expiresAt > this.now()) {
            const message = this.messages.get(duplicate.messageId);
            if (message) return message.receipt;
        }

        const createdAt = this.now();
        const messageId = this.id();
        const admission: MessageAdmission = {
            canonicalDigest,
            createdAt,
            fingerprint,
            from,
            idempotencyMapKey,
            input,
            messageId,
        };
        const baseExpiresAt = createdAt + input.ttlMs;
        let to: AgentEndpointSummary | undefined;
        try {
            to = this.endpoints.resolve(input.to);
        } catch {
            return this.storeTerminal(
                admission,
                baseExpiresAt,
                'unavailable',
                'target_unavailable',
            );
        }
        const targetExpiresAt = Math.min(baseExpiresAt, to.expiresAt);
        if (to.projectId !== from.projectId || to.messaging.deliveryMode === 'unavailable') {
            const reason = to.projectId === from.projectId ? 'target_unavailable' : 'cross_project';
            return this.storeTerminal(admission, targetExpiresAt, 'unavailable', reason, to);
        }

        let depth = 0;
        if (input.replyTo) {
            const parent = this.messages.get(input.replyTo);
            if (
                parent?.receipt.status !== 'delivered' ||
                !referencesEqual(parent.receipt.to, from.ref) ||
                !referencesEqual(parent.receipt.from, input.to)
            )
                throw new CaxriError(
                    'VALIDATION',
                    'replyTo must identify a delivered message from the exact target generation',
                );
            depth = parent.depth + 1;
            if (depth > MAX_REPLY_DEPTH)
                return this.storeTerminal(
                    admission,
                    targetExpiresAt,
                    'capacity',
                    'reply_depth_exceeded',
                    to,
                    depth,
                );
        }

        if (!this.admitPairTraffic(from.ref, to.ref, createdAt))
            return this.storeTerminal(
                admission,
                targetExpiresAt,
                'capacity',
                'pair_rate_limited',
                to,
                depth,
            );

        const receiverPolicy = this.policies.get(endpointKey(to.ref)) ?? {
            policy: 'auto' as const,
            heldRetention: 'approval-window' as const,
        };
        const status = decideInboundStatus(
            receiverPolicy.policy,
            from.permissionClass,
            to.permissionClass,
        );
        const expiresAt =
            status === 'held' &&
            receiverPolicy.policy === 'hold' &&
            receiverPolicy.heldRetention === 'endpoint'
                ? to.expiresAt
                : Math.min(
                      baseExpiresAt,
                      status === 'held' ? createdAt + AGENT_MESSAGE_APPROVAL_TTL_MS : to.expiresAt,
                  );
        if (status === 'refused')
            return this.storeTerminal(admission, expiresAt, 'refused', 'policy_refused', to, depth);

        const receiverKey = endpointKey(to.ref);
        const queue = status === 'held' ? this.held : this.waiting;
        const limit = status === 'held' ? MAX_HELD_PER_ENDPOINT : MAX_WAITING_PER_ENDPOINT;
        const byteLength = Buffer.byteLength(input.body, 'utf8');
        const isQueueFull = (queue.get(receiverKey)?.length ?? 0) >= limit;
        if (
            isQueueFull ||
            this.pendingMessages >= MAX_PENDING_MESSAGES ||
            this.pendingBytes + byteLength > MAX_PENDING_BYTES
        ) {
            const reason = isQueueFull ? 'queue_full' : 'pending_limit_reached';
            return this.storeTerminal(admission, expiresAt, 'capacity', reason, to, depth);
        }

        const receipt = this.newReceipt(from.ref, input, messageId, createdAt, expiresAt, status);
        const message: StoredMessage = {
            body: input.body,
            byteLength,
            depth,
            fingerprint,
            from,
            idempotencyMapKey,
            receipt,
            state: status,
            to,
        };
        this.store(message, canonicalDigest);
        this.pendingMessages += 1;
        this.pendingBytes += byteLength;
        pushQueued(queue, receiverKey, messageId);
        this.scheduleExpiry(message);
        this.logTransition(message, null, 'admitted');
        this.emitReceipt(message);
        if (status === 'held') this.options.emitHeld?.(heldMessageProjection(message));
        else this.satisfyWaiter(receiverKey);
        return receipt;
    }

    private storeTerminal(
        {
            canonicalDigest,
            createdAt,
            fingerprint,
            from,
            idempotencyMapKey,
            input,
            messageId,
        }: MessageAdmission,
        expiresAt: number,
        status: Extract<AgentMessageReceipt['status'], 'capacity' | 'refused' | 'unavailable'>,
        reason: AgentMessageTransitionReason,
        to?: AgentEndpointSummary,
        depth = 0,
    ): AgentMessageReceipt {
        const receipt = this.newReceipt(from.ref, input, messageId, createdAt, expiresAt, status);
        const message: StoredMessage = {
            byteLength: 0,
            depth,
            fingerprint,
            from,
            idempotencyMapKey,
            receipt,
            state: status,
            to,
        };
        this.store(message, canonicalDigest);
        this.logTransition(message, null, reason);
        this.emitReceipt(message);
        return receipt;
    }

    private newReceipt(
        from: AgentEndpointReference,
        input: AgentMessageSendInput,
        messageId: string,
        createdAt: number,
        expiresAt: number,
        status: AgentMessageReceipt['status'],
    ): AgentMessageReceipt {
        return {
            messageId,
            from,
            to: input.to,
            status,
            createdAt,
            updatedAt: createdAt,
            expiresAt: Math.max(createdAt + 1, expiresAt),
            ...(input.replyTo && { replyTo: input.replyTo }),
            ...(input.dispatchId && { dispatchId: input.dispatchId }),
        };
    }

    private store(message: StoredMessage, canonicalDigest: string): void {
        this.admitReceipt();
        this.messages.set(message.receipt.messageId, message);
        this.idempotency.set(message.idempotencyMapKey, {
            digest: canonicalDigest,
            messageId: message.receipt.messageId,
        });
        // Fixed TTL makes Map insertion order equal expiry order, so capacity eviction removes the
        // oldest entry; `set` keeps an existing key's position, so delete first to preserve that.
        this.duplicates.delete(message.fingerprint);
        while (this.duplicates.size >= MAX_DUPLICATES)
            this.duplicates.delete(this.duplicates.keys().next().value!);
        this.duplicates.set(message.fingerprint, {
            messageId: message.receipt.messageId,
            expiresAt: this.now() + DUPLICATE_WINDOW_MS,
        });
    }

    private releaseDuplicate({ fingerprint, receipt }: StoredMessage): void {
        const entry = this.duplicates.get(fingerprint);
        if (entry?.messageId === receipt.messageId) this.duplicates.delete(fingerprint);
    }

    private admitReceipt(): void {
        if (this.messages.size < MAX_RECEIPTS) return;
        const terminal = [...this.messages].find(
            ([, message]) =>
                message.state !== 'waiting' &&
                message.state !== 'held' &&
                message.state !== 'delivering',
        );
        if (!terminal)
            throw new CaxriError('CAPACITY', 'Agent message receipt capacity is exhausted');
        this.messages.delete(terminal[0]);
        this.releaseIdempotency(terminal[1]);
        this.releaseDuplicate(terminal[1]);
    }

    private releaseIdempotency({ idempotencyMapKey, receipt }: StoredMessage): void {
        const entry = this.idempotency.get(idempotencyMapKey);
        if (entry?.messageId === receipt.messageId) this.idempotency.delete(idempotencyMapKey);
    }

    private reserve(
        message: StoredMessage,
        receiverKey: string,
        requestId: string,
    ): AgentInboundMessage {
        if (!message.body)
            throw new CaxriError('INTERNAL', 'Waiting Agent message lost its in-memory body');
        message.state = 'delivering';
        this.reservations.set(requestId, {
            endpointKey: receiverKey,
            messageId: message.receipt.messageId,
        });
        return {
            id: message.receipt.messageId,
            origin: 'peer',
            from: message.from,
            to: message.receipt.to,
            body: message.body,
            createdAt: message.receipt.createdAt,
            expiresAt: message.receipt.expiresAt,
            ...(message.receipt.replyTo && { replyTo: message.receipt.replyTo }),
        };
    }

    private satisfyWaiter(receiverKey: string): void {
        const waiter = this.waiters.get(receiverKey);
        if (!waiter) return;
        const message = this.shiftWaiting(receiverKey);
        if (!message) return;
        clearTimeout(waiter.timer);
        this.waiters.delete(receiverKey);
        waiter.resolve({
            message: this.reserve(message, receiverKey, waiter.requestId),
            outcome: 'message',
        });
    }

    private shiftWaiting(receiverKey: string): StoredMessage | undefined {
        const queue = this.waiting.get(receiverKey);
        while (queue?.length) {
            const id = queue.shift()!;
            const message = this.messages.get(id);
            if (message?.state === 'waiting') return message;
        }
        if (queue?.length === 0) this.waiting.delete(receiverKey);
        return undefined;
    }

    private finish(
        message: StoredMessage,
        status: Extract<
            AgentMessageReceipt['status'],
            'capacity' | 'delivered' | 'expired' | 'refused' | 'unavailable'
        >,
        reason: AgentMessageTransitionReason,
    ): void {
        if (!PENDING_MESSAGE_STATES.includes(message.state)) return;
        const previousStatus = message.receipt.status;
        if (message.to) {
            const key = endpointKey(message.to.ref);
            removeQueued(this.waiting, key, message.receipt.messageId);
            removeQueued(this.held, key, message.receipt.messageId);
        }
        if (message.timer) clearTimeout(message.timer);
        message.timer = undefined;
        this.pendingMessages -= 1;
        this.pendingBytes -= message.byteLength;
        message.body = undefined;
        message.byteLength = 0;
        message.state = status;
        message.receipt = { ...message.receipt, status, updatedAt: this.now() };
        this.logTransition(message, previousStatus, reason);
        this.emitReceipt(message);
    }

    /**
     * Ends a pending message whose lifetime ran out, naming whether it ran out in the approval window or the queue.
     */
    private expire(message: StoredMessage): void {
        this.finish(message, 'expired', message.state === 'held' ? 'held_expired' : 'ttl_elapsed');
    }

    private logTransition(
        message: StoredMessage,
        previousStatus: AgentMessageReceipt['status'] | null,
        reason: AgentMessageTransitionReason,
    ): void {
        const key = endpointKey(message.receipt.to);
        const queueDepth = (this.waiting.get(key)?.length ?? 0) + (this.held.get(key)?.length ?? 0);
        logMessageTransition(
            this.options.logger,
            message,
            previousStatus,
            reason,
            queueDepth,
            this.now(),
        );
    }

    private emitReceipt(message: StoredMessage): void {
        this.options.emitReceipt?.(message.from.ref, message.receipt);
    }

    private scheduleExpiry(message: StoredMessage): void {
        message.timer = setTimeout(
            () => this.expire(message),
            Math.max(1, message.receipt.expiresAt - this.now()),
        );
        message.timer.unref();
    }

    private admitPairTraffic(
        from: AgentEndpointReference,
        to: AgentEndpointReference,
        now: number,
    ): boolean {
        const key = [endpointKey(from), endpointKey(to)]
            .toSorted((left, right) => left.localeCompare(right))
            .join('|');
        const recent = (this.pairTraffic.get(key) ?? []).filter(
            (timestamp) => timestamp > now - LOOP_WINDOW_MS,
        );
        if (recent.length >= MAX_PAIR_MESSAGES_PER_WINDOW) {
            this.pairTraffic.set(key, recent);
            return false;
        }
        recent.push(now);
        this.pairTraffic.set(key, recent);
        return true;
    }

    private sweep(): void {
        const now = this.now();
        for (const message of this.messages.values()) {
            if (message.receipt.expiresAt <= now && PENDING_MESSAGE_STATES.includes(message.state))
                this.expire(message);
        }
        for (const [fingerprint, record] of this.duplicates) {
            if (record.expiresAt <= now) this.duplicates.delete(fingerprint);
        }
        for (const [key, timestamps] of this.pairTraffic) {
            const recent = timestamps.filter((timestamp) => timestamp > now - LOOP_WINDOW_MS);
            if (recent.length > 0) this.pairTraffic.set(key, recent);
            else this.pairTraffic.delete(key);
        }
    }

    send(
        context: CommandExecutionContext,
        input: AgentMessageSendInput,
        requestId: string,
        wakeDispatchId?: string,
    ): AgentMessageReceipt {
        return this.admit(
            context,
            wakeDispatchId ? { ...input, dispatchId: wakeDispatchId } : input,
            input.idempotencyKey ?? requestId,
        );
    }

    reply(
        context: CommandExecutionContext,
        input: AgentMessageSendInput & { replyTo: string },
        requestId: string,
    ): AgentMessageReceipt {
        return this.admit(context, input, input.idempotencyKey ?? requestId);
    }

    receipt(context: CommandExecutionContext, messageId: string): AgentMessageReceipt {
        this.sweep();
        const sender = resolveSender(this.endpoints, context);
        const message = this.messages.get(messageId);
        if (!message || !referencesEqual(message.from.ref, sender.ref))
            throw new CaxriError('NOT_FOUND', 'Agent message receipt was not found');
        return message.receipt;
    }

    policy(context: CommandExecutionContext): {
        policy: AgentInboundPolicy;
        heldRetention: AgentHeldRetention;
    } {
        const endpoint = resolveSender(this.endpoints, context);
        return (
            this.policies.get(endpointKey(endpoint.ref)) ?? {
                policy: 'auto',
                heldRetention: 'approval-window',
            }
        );
    }

    setPolicy(
        context: CommandExecutionContext,
        value: { policy: AgentInboundPolicy; heldRetention: AgentHeldRetention },
    ): { policy: AgentInboundPolicy; heldRetention: AgentHeldRetention } {
        const endpoint = resolveSender(this.endpoints, context);
        const normalized =
            value.policy === 'hold'
                ? value
                : { policy: value.policy, heldRetention: 'approval-window' as const };
        this.policies.set(endpointKey(endpoint.ref), normalized);
        return normalized;
    }

    listHeld(): AgentHeldMessage[] {
        this.sweep();
        return this.messages
            .values()
            .filter((message) => message.state === 'held' && message.body && message.to)
            .toArray()
            .toSorted((left, right) => left.receipt.createdAt - right.receipt.createdAt)
            .map(heldMessageProjection);
    }

    heldDetail(messageId: string): AgentHeldMessageDetail | null {
        this.sweep();
        const message = this.messages.get(messageId);
        if (!message) throw new CaxriError('NOT_FOUND', 'Held Agent message was not found');
        /**
         * A Desktop read can race the receipt event that removes a message from the approval dialog. `null` keeps a
         * known terminal receipt out of the error channel without weakening unknown-ID validation or retaining body.
         */
        if (message.state !== 'held') return null;
        return heldMessageDetail(message);
    }

    approve(messageId: string): AgentMessageReceipt {
        this.sweep();
        const message = this.messages.get(messageId);
        if (!message) throw new CaxriError('NOT_FOUND', 'Held Agent message was not found');
        if (message.state !== 'held') return message.receipt;
        if (!message.to) throw new CaxriError('NOT_FOUND', 'Held Agent message was not found');
        this.endpoints.resolve(message.to.ref);
        const receiverKey = endpointKey(message.to.ref);
        if ((this.waiting.get(receiverKey)?.length ?? 0) >= MAX_WAITING_PER_ENDPOINT) {
            this.finish(message, 'capacity', 'queue_full');
            return message.receipt;
        }
        removeQueued(this.held, endpointKey(message.to.ref), messageId);
        message.state = 'waiting';
        message.receipt = {
            ...message.receipt,
            status: 'waiting',
            updatedAt: this.now(),
        };
        pushQueued(this.waiting, receiverKey, messageId);
        this.logTransition(message, 'held', 'user_approved');
        this.emitReceipt(message);
        this.satisfyWaiter(receiverKey);
        return message.receipt;
    }

    deny(messageId: string): AgentMessageReceipt {
        this.sweep();
        const message = this.messages.get(messageId);
        if (!message) throw new CaxriError('NOT_FOUND', 'Held Agent message was not found');
        if (message.state !== 'held') return message.receipt;
        this.finish(message, 'refused', 'user_denied');
        return message.receipt;
    }

    wait(
        context: CommandExecutionContext,
        timeoutMs: number,
        requestId: string,
    ): Promise<AgentMessagePullResult> {
        this.sweep();
        const receiver = resolvePullReceiver(this.endpoints, context);
        const key = endpointKey(receiver.ref);
        if (
            this.waiters.has(key) ||
            this.reservations.values().some((reservation) => reservation.endpointKey === key)
        )
            throw new CaxriError('CONFLICT', 'Agent Endpoint already has an active message wait');
        const message = this.shiftWaiting(key);
        if (message)
            return Promise.resolve({
                message: this.reserve(message, key, requestId),
                outcome: 'message',
            });
        return new Promise((resolve) => {
            const waiter: MessageWaiter = {
                endpointKey: key,
                requestId,
                resolve,
                timer: setTimeout(() => {
                    if (this.waiters.get(key) === waiter) this.waiters.delete(key);
                    resolve({ message: null, outcome: 'timed_out' });
                }, timeoutMs),
            };
            waiter.timer.unref();
            this.waiters.set(key, waiter);
        });
    }

    check(context: CommandExecutionContext, requestId: string): AgentMessagePullResult {
        this.sweep();
        const receiver = resolvePullReceiver(this.endpoints, context);
        const key = endpointKey(receiver.ref);
        if (
            this.waiters.has(key) ||
            this.reservations.values().some((reservation) => reservation.endpointKey === key)
        )
            throw new CaxriError('CONFLICT', 'Agent Endpoint already has an active message wait');
        const message = this.shiftWaiting(key);
        return message
            ? { message: this.reserve(message, key, requestId), outcome: 'message' }
            : { message: null, outcome: 'empty' };
    }

    /**
     * Marks a pull delivered only after `ControlServer` confirms its reply crossed the socket.
     */
    confirmWait(requestId: string, context: CommandExecutionContext): void {
        const reservation = this.reservations.get(requestId);
        if (!reservation) return;
        let receiver: AgentEndpointSummary;
        try {
            receiver = resolveSender(this.endpoints, context);
        } catch {
            this.cancelWait(requestId);
            return;
        }
        if (endpointKey(receiver.ref) !== reservation.endpointKey) return;
        this.reservations.delete(requestId);
        const message = this.messages.get(reservation.messageId);
        if (message?.state === 'delivering') this.finish(message, 'delivered', 'pulled');
    }

    /**
     * Requeues an unflushed pull at the FIFO front, or resolves an abandoned long poll.
     */
    cancelWait(requestId: string): void {
        for (const [key, waiter] of this.waiters) {
            if (waiter.requestId !== requestId) continue;
            clearTimeout(waiter.timer);
            this.waiters.delete(key);
            waiter.resolve({ message: null, outcome: 'empty' });
            return;
        }
        const reservation = this.reservations.get(requestId);
        if (!reservation) return;
        this.reservations.delete(requestId);
        const message = this.messages.get(reservation.messageId);
        if (message?.state !== 'delivering') return;
        if (message.receipt.expiresAt <= this.now()) {
            this.expire(message);
            return;
        }
        try {
            this.endpoints.resolve(message.receipt.to);
        } catch {
            this.finish(message, 'expired', 'endpoint_retired');
            return;
        }
        message.state = 'waiting';
        const queue = this.waiting.get(reservation.endpointKey) ?? [];
        queue.unshift(message.receipt.messageId);
        this.waiting.set(reservation.endpointKey, queue);
    }

    retire(reference: AgentEndpointReference): void {
        const key = endpointKey(reference);
        const waiter = this.waiters.get(key);
        if (waiter) {
            clearTimeout(waiter.timer);
            this.waiters.delete(key);
            waiter.resolve({ message: null, outcome: 'empty' });
        }
        for (const [requestId, reservation] of this.reservations) {
            if (reservation.endpointKey === key) this.reservations.delete(requestId);
        }
        for (const message of this.messages.values()) {
            const isSender = referencesEqual(message.receipt.from, reference);
            if (isSender) this.releaseIdempotency(message);
            if (!isSender && !referencesEqual(message.receipt.to, reference)) continue;
            // A retired generation can never satisfy its fingerprints again; releasing them keeps
            // retirement consistent with receipt eviction and close.
            this.releaseDuplicate(message);
            if (PENDING_MESSAGE_STATES.includes(message.state))
                this.finish(message, 'expired', 'endpoint_retired');
        }
        this.policies.delete(key);
        this.waiting.delete(key);
        this.held.delete(key);
    }

    close(): void {
        for (const waiter of this.waiters.values()) {
            clearTimeout(waiter.timer);
            waiter.resolve({ message: null, outcome: 'empty' });
        }
        this.waiters.clear();
        this.reservations.clear();
        for (const message of this.messages.values()) {
            if (message.timer) clearTimeout(message.timer);
            message.body = undefined;
        }
        this.messages.clear();
        this.waiting.clear();
        this.held.clear();
        this.idempotency.clear();
        this.duplicates.clear();
        this.pairTraffic.clear();
        this.pendingBytes = 0;
        this.pendingMessages = 0;
    }
}
