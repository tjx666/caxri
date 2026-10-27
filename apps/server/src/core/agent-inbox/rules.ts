import { createHash } from 'node:crypto';

import type {
    AgentEndpointRef as AgentEndpointReference,
    AgentEndpointSummary,
    AgentHeldMessage,
    AgentHeldMessageDetail,
    AgentInboundPolicy,
    AgentPermissionClass,
    CommandExecutionContext,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { AgentEndpointRegistry } from '../agent-endpoints';
import type { PendingState, StoredMessage } from './types';

export const MAX_WAITING_PER_ENDPOINT = 50;
export const MAX_HELD_PER_ENDPOINT = 100;
export const MAX_PENDING_MESSAGES = 1_024;
export const MAX_PENDING_BYTES = 4 * 1024 * 1024;
export const MAX_RECEIPTS = 4_096;
export const DUPLICATE_WINDOW_MS = 30_000;
/**
 * Duplicate fingerprints are bounded by capacity as well as TTL: invalid-target sends bypass `admitPairTraffic`, so
 * throughput alone must not grow Server Core memory inside one TTL window. Capacity eviction only lowers the dedup hit
 * rate; it never changes delivery semantics.
 */
export const MAX_DUPLICATES = 4_096;
export const LOOP_WINDOW_MS = 5 * 60 * 1_000;
export const MAX_PAIR_MESSAGES_PER_WINDOW = 16;
export const MAX_REPLY_DEPTH = 8;

// The exact states still "in flight" toward eventual delivery; shared so every inbox guard
// checks membership consistently instead of repeating equality chains.
export const PENDING_MESSAGE_STATES: ReadonlyArray<StoredMessage['state']> = [
    'waiting',
    'held',
    'delivering',
] satisfies readonly PendingState[];

export function endpointKey(reference: AgentEndpointReference): string {
    return `${reference.hostId}:${reference.endpointId}:${reference.generation}`;
}

export function areReferencesEqual(
    left: AgentEndpointReference,
    right: AgentEndpointReference,
): boolean {
    return endpointKey(left) === endpointKey(right);
}

export function agentMessageDigest(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function boundedPreview(body: string): string {
    return [...body].slice(0, 240).join('');
}

export function heldMessageProjection(message: StoredMessage): AgentHeldMessage {
    if (!message.body || !message.to)
        throw new CaxriError('INTERNAL', 'Held Agent message lost its in-memory body');
    return {
        messageId: message.receipt.messageId,
        from: message.from,
        to: message.to.ref,
        preview: boundedPreview(message.body),
        byteLength: message.byteLength,
        createdAt: message.receipt.createdAt,
        expiresAt: message.receipt.expiresAt,
        ...(message.receipt.replyTo && { replyTo: message.receipt.replyTo }),
    };
}

export function heldMessageDetail(message: StoredMessage): AgentHeldMessageDetail {
    if (!message.body)
        throw new CaxriError('INTERNAL', 'Held Agent message lost its in-memory body');
    return { ...heldMessageProjection(message), body: message.body };
}

export function resolveSender(
    endpoints: AgentEndpointRegistry,
    context: CommandExecutionContext,
): AgentEndpointSummary {
    return endpoints.context(context).endpoint;
}

export function resolvePullReceiver(
    endpoints: AgentEndpointRegistry,
    context: CommandExecutionContext,
): AgentEndpointSummary {
    const receiver = resolveSender(endpoints, context);
    if (receiver.messaging.deliveryMode === 'unavailable')
        throw new CaxriError('UNAVAILABLE', 'Agent Endpoint has no message adapter', {
            reason: receiver.messaging.reason,
            nextAction: receiver.messaging.nextAction,
        });
    if (receiver.messaging.deliveryMode !== 'pull')
        throw new CaxriError('CONFLICT', 'Agent Endpoint uses Provider push messaging', {
            reason: 'delivery_mode_push',
            nextAction: 'none',
        });
    return receiver;
}

/**
 * The complete auto-policy matrix is intentionally small enough to exhaustively regression test.
 */
export function decideInboundStatus(
    policy: AgentInboundPolicy,
    sender: AgentPermissionClass,
    receiver: AgentPermissionClass,
): 'waiting' | 'held' | 'refused' {
    if (policy === 'refuse') return 'refused';
    if (policy === 'hold') return 'held';
    if (policy === 'accept') return 'waiting';
    return sender !== 'unknown' && sender === receiver ? 'waiting' : 'held';
}

/**
 * Appends a message ID to one endpoint's FIFO queue.
 */
export function pushQueued(map: Map<string, string[]>, key: string, messageId: string): void {
    const queue = map.get(key) ?? [];
    queue.push(messageId);
    map.set(key, queue);
}

/**
 * Removes a message ID from one endpoint's queue, dropping the queue once it is empty.
 */
export function removeQueued(map: Map<string, string[]>, key: string, messageId: string): void {
    const queue = map.get(key);
    if (!queue) return;
    const index = queue.indexOf(messageId);
    if (index !== -1) queue.splice(index, 1);
    if (queue.length === 0) map.delete(key);
}
