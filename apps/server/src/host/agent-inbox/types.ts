import type {
    AgentEndpointRef as AgentEndpointReference,
    AgentEndpointSummary,
    AgentHeldMessage,
    AgentMessagePullResult,
    AgentMessageReceipt,
} from '@caxri/protocol';

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
    now?: () => number;
}

export interface AgentMessageSendInput {
    body: string;
    dispatchId?: string;
    idempotencyKey?: string;
    replyTo?: string;
    to: AgentEndpointReference;
    ttlMs: number;
}
