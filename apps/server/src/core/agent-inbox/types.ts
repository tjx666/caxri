import type {
    AgentEndpointRef as AgentEndpointReference,
    AgentEndpointSummary,
    AgentHeldMessage,
    AgentMessagePullResult,
    AgentMessageReceipt,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

export type PendingState = 'waiting' | 'held' | 'delivering';

export interface StoredMessage {
    body?: string;
    byteLength: number;
    depth: number;
    fingerprint: string;
    from: AgentEndpointSummary;
    idempotencyMapKey: string;
    receipt: AgentMessageReceipt;
    state: PendingState | AgentMessageReceipt['status'];
    timer?: NodeJS.Timeout;
    to?: AgentEndpointSummary;
}

export interface IdempotencyReceipt {
    digest: string;
    messageId: string;
}

export interface DuplicateReceipt {
    expiresAt: number;
    messageId: string;
}

export interface MessageWaiter {
    endpointKey: string;
    requestId: string;
    resolve(value: AgentMessagePullResult): void;
    timer: NodeJS.Timeout;
}

export interface DeliveryReservation {
    endpointKey: string;
    messageId: string;
}

export interface AgentInboxRegistryOptions {
    emitHeld?(message: AgentHeldMessage): void;
    emitReceipt?(endpoint: AgentEndpointReference, receipt: AgentMessageReceipt): void;
    id?: () => string;
    /**
     * Receives one content-free `agent_message.transitioned` record per receipt status change.
     */
    logger?: Pick<StructuredLogger, 'write'>;
    now?: () => number;
}

/**
 * What every admitted or rejected send shares, computed once before the admission checks.
 */
export interface MessageAdmission {
    canonicalDigest: string;
    createdAt: number;
    fingerprint: string;
    from: AgentEndpointSummary;
    idempotencyMapKey: string;
    input: AgentMessageSendInput;
    messageId: string;
}

export interface AgentMessageSendInput {
    body: string;
    dispatchId?: string;
    idempotencyKey?: string;
    replyTo?: string;
    to: AgentEndpointReference;
    ttlMs: number;
}
