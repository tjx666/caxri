import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import type {
    AgentEndpointRef as AgentEndpointReference,
    AgentEndpointSummary,
} from '../../shared/ipc/agent-endpoint-contract';
import type {
    AgentHeldMessage,
    AgentHeldMessageDetail,
    AgentHeldRetention,
    AgentInboundMessage,
    AgentInboundPolicy,
    AgentMessagePullResult,
    AgentMessageReceipt,
} from '../../shared/ipc/agent-inbox-contract';
import { AGENT_MESSAGE_APPROVAL_TTL_MS } from '../../shared/ipc/agent-inbox-contract';
import { CaxriError } from '../../shared/ipc/errors';
import type { CommandExecutionContext } from '../../shared/ipc/principal';
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
    MAX_HELD_PER_ENDPOINT,
    MAX_PAIR_MESSAGES_PER_WINDOW,
    MAX_PENDING_BYTES,
    MAX_PENDING_MESSAGES,
    MAX_RECEIPTS,
    MAX_REPLY_DEPTH,
    MAX_WAITING_PER_ENDPOINT,
    resolvePullReceiver,
    resolveSender,
} from './rules';
import type {
    AgentInboxRegistryOptions,
    AgentMessageSendInput,
    DeliveryReservation,
    DuplicateReceipt,
    IdempotencyReceipt,
    MessageWaiter,
    PendingState,
    StoredMessage,
} from './types';

// A message is still "in flight" toward eventual delivery in exactly these states; shared so
// every guard below checks membership consistently instead of repeating equality chains.
const PENDING_MESSAGE_STATES: ReadonlyArray<StoredMessage['state']> = [
    'waiting',
    'held',
    'delivering',
] satisfies readonly PendingState[];

/**
Host-memory Peer Inbox. Bodies never cross into persistence, logs, Runtime, or terminal input.
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
                this.finish(message, 'unavailable');
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
        const baseExpiresAt = createdAt + input.ttlMs;
        let to: AgentEndpointSummary | undefined;
        try {
            to = this.endpoints.resolve(input.to);
        } catch {
            return this.storeTerminal(
                from,
                input,
                messageId,
                createdAt,
                baseExpiresAt,
                'unavailable',
                fingerprint,
                canonicalDigest,
                idempotencyMapKey,
            );
        }
        if (to.projectId !== from.projectId || to.messaging.deliveryMode === 'unavailable')
            return this.storeTerminal(
                from,
                input,
                messageId,
                createdAt,
                Math.min(baseExpiresAt, to.expiresAt),
                'unavailable',
                fingerprint,
                canonicalDigest,
                idempotencyMapKey,
                to,
            );

        let depth = 0;
        if (input.replyTo) {
            const parent = this.messages.get(input.replyTo);
            if (
                !parent ||
                parent.receipt.status !== 'delivered' ||
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
                    from,
                    input,
                    messageId,
                    createdAt,
                    Math.min(baseExpiresAt, to.expiresAt),
                    'capacity',
                    fingerprint,
                    canonicalDigest,
                    idempotencyMapKey,
                    to,
                    depth,
                );
        }

        if (!this.admitPairTraffic(from.ref, to.ref, createdAt))
            return this.storeTerminal(
                from,
                input,
                messageId,
                createdAt,
                Math.min(baseExpiresAt, to.expiresAt),
                'capacity',
                fingerprint,
                canonicalDigest,
                idempotencyMapKey,
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
            return this.storeTerminal(
                from,
                input,
                messageId,
                createdAt,
                expiresAt,
                'refused',
                fingerprint,
                canonicalDigest,
                idempotencyMapKey,
                to,
                depth,
            );

        const receiverKey = endpointKey(to.ref);
        const queue = status === 'held' ? this.held : this.waiting;
        const limit = status === 'held' ? MAX_HELD_PER_ENDPOINT : MAX_WAITING_PER_ENDPOINT;
        const byteLength = Buffer.byteLength(input.body, 'utf8');
        if (
            (queue.get(receiverKey)?.length ?? 0) >= limit ||
            this.pendingMessages >= MAX_PENDING_MESSAGES ||
            this.pendingBytes + byteLength > MAX_PENDING_BYTES
        )
            return this.storeTerminal(
                from,
                input,
                messageId,
                createdAt,
                expiresAt,
                'capacity',
                fingerprint,
                canonicalDigest,
                idempotencyMapKey,
                to,
                depth,
            );

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
        this.pushQueued(queue, receiverKey, messageId);
        this.scheduleExpiry(message);
        this.emitReceipt(message);
        if (status === 'held') this.options.emitHeld?.(heldMessageProjection(message));
        else this.satisfyWaiter(receiverKey);
        return receipt;
    }

    private storeTerminal(
        from: AgentEndpointSummary,
        input: AgentMessageSendInput,
        messageId: string,
        createdAt: number,
        expiresAt: number,
        status: Extract<AgentMessageReceipt['status'], 'capacity' | 'refused' | 'unavailable'>,
        fingerprint: string,
        canonicalDigest: string,
        idempotencyMapKey: string,
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
        this.duplicates.set(message.fingerprint, {
            messageId: message.receipt.messageId,
            expiresAt: this.now() + DUPLICATE_WINDOW_MS,
        });
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
    ): void {
        if (!PENDING_MESSAGE_STATES.includes(message.state)) return;
        if (message.to) {
            const key = endpointKey(message.to.ref);
            this.removeQueued(this.waiting, key, message.receipt.messageId);
            this.removeQueued(this.held, key, message.receipt.messageId);
        }
        if (message.timer) clearTimeout(message.timer);
        message.timer = undefined;
        this.pendingMessages -= 1;
        this.pendingBytes -= message.byteLength;
        message.body = undefined;
        message.byteLength = 0;
        message.state = status;
        message.receipt = { ...message.receipt, status, updatedAt: this.now() };
        this.emitReceipt(message);
    }

    private emitReceipt(message: StoredMessage): void {
        this.options.emitReceipt?.(message.from.ref, message.receipt);
    }

    private scheduleExpiry(message: StoredMessage): void {
        message.timer = setTimeout(
            () => this.finish(message, 'expired'),
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
                this.finish(message, 'expired');
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

    private pushQueued(map: Map<string, string[]>, key: string, messageId: string): void {
        const queue = map.get(key) ?? [];
        queue.push(messageId);
        map.set(key, queue);
    }

    private removeQueued(map: Map<string, string[]>, key: string, messageId: string): void {
        const queue = map.get(key);
        if (!queue) return;
        const index = queue.indexOf(messageId);
        if (index !== -1) queue.splice(index, 1);
        if (queue.length === 0) map.delete(key);
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

    heldDetail(messageId: string): AgentHeldMessageDetail {
        this.sweep();
        const message = this.messages.get(messageId);
        if (!message || message.state !== 'held')
            throw new CaxriError('NOT_FOUND', 'Held Agent message was not found');
        return heldMessageDetail(message);
    }

    approve(messageId: string): AgentMessageReceipt {
        this.sweep();
        const message = this.messages.get(messageId);
        if (!message || message.state !== 'held' || !message.to)
            throw new CaxriError('NOT_FOUND', 'Held Agent message was not found');
        this.endpoints.resolve(message.to.ref);
        const receiverKey = endpointKey(message.to.ref);
        if ((this.waiting.get(receiverKey)?.length ?? 0) >= MAX_WAITING_PER_ENDPOINT) {
            this.finish(message, 'capacity');
            return message.receipt;
        }
        this.removeQueued(this.held, endpointKey(message.to.ref), messageId);
        message.state = 'waiting';
        message.receipt = {
            ...message.receipt,
            status: 'waiting',
            updatedAt: this.now(),
        };
        this.pushQueued(this.waiting, receiverKey, messageId);
        this.emitReceipt(message);
        this.satisfyWaiter(receiverKey);
        return message.receipt;
    }

    deny(messageId: string): AgentMessageReceipt {
        this.sweep();
        const message = this.messages.get(messageId);
        if (!message || message.state !== 'held')
            throw new CaxriError('NOT_FOUND', 'Held Agent message was not found');
        this.finish(message, 'refused');
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
    Marks a pull delivered only after LocalHostServer confirms its reply crossed the socket.
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
        if (message?.state === 'delivering') this.finish(message, 'delivered');
    }

    /**
    Requeues an unflushed pull at the FIFO front, or resolves an abandoned long poll.
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
        if (!message || message.state !== 'delivering') return;
        if (message.receipt.expiresAt <= this.now()) {
            this.finish(message, 'expired');
            return;
        }
        try {
            this.endpoints.resolve(message.receipt.to);
        } catch {
            this.finish(message, 'expired');
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
            if (referencesEqual(message.receipt.from, reference)) this.releaseIdempotency(message);
            if (
                (referencesEqual(message.receipt.from, reference) ||
                    referencesEqual(message.receipt.to, reference)) &&
                PENDING_MESSAGE_STATES.includes(message.state)
            )
                this.finish(message, 'expired');
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
