import type { CaxriMethod } from '../registry/methods.js';
import type { CommandReplyEnvelope } from './transport.js';

export interface StoredProtocolCommandReceipt {
    clientId: string;
    createdAt: number;
    method: CaxriMethod;
    reply: CommandReplyEnvelope;
    requestFingerprint: string;
    requestId: string;
    stateEpoch: string;
}

export interface NewProtocolCommandReceipt {
    clientId: string;
    createdAt: number;
    method: CaxriMethod;
    reply: CommandReplyEnvelope;
    requestFingerprint: string;
    requestId: string;
    stateEpoch: string;
}

/**
 * Browser-safe persistence contract consumed by the dispatcher. Implementations may be synchronous (local SQLite) or
 * asynchronous (a future platform store); dispatch always awaits both paths before exposing a reply.
 */
export interface DurableCommandReceiptStore {
    getReceipt(
        stateEpoch: string,
        clientId: string,
        requestId: string,
    ): Promise<StoredProtocolCommandReceipt | undefined> | StoredProtocolCommandReceipt | undefined;
    saveReceipt(
        input: NewProtocolCommandReceipt,
    ): Promise<StoredProtocolCommandReceipt> | StoredProtocolCommandReceipt;
}
