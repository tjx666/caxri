import { createHash } from 'node:crypto';

import type {
    AgentEndpointRef as AgentEndpointReference,
    AgentEndpointSummary,
    AgentPermissionClass,
} from '../../shared/ipc/agent-endpoint-contract';
import type {
    AgentHeldMessage,
    AgentHeldMessageDetail,
    AgentInboundPolicy,
} from '../../shared/ipc/agent-inbox-contract';
import { CaxriError } from '../../shared/ipc/errors';
import type { CommandExecutionContext } from '../../shared/ipc/principal';
import type { AgentEndpointRegistry } from '../agent-endpoints';
import type { StoredMessage } from './types';

export const MAX_WAITING_PER_ENDPOINT = 50;
export const MAX_HELD_PER_ENDPOINT = 100;
export const MAX_PENDING_MESSAGES = 1_024;
export const MAX_PENDING_BYTES = 4 * 1024 * 1024;
export const MAX_RECEIPTS = 4_096;
export const DUPLICATE_WINDOW_MS = 30_000;
export const LOOP_WINDOW_MS = 5 * 60 * 1_000;
export const MAX_PAIR_MESSAGES_PER_WINDOW = 16;
export const MAX_REPLY_DEPTH = 8;

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
