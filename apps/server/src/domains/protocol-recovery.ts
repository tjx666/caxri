import type {
    CaxriMethod,
    CommandReplyEnvelope,
    DurableServerEvent,
    ProtocolEventEnvelope,
} from '@caxri/protocol';

export interface DurableProtocolIdentity {
    serverId: string;
    stateEpoch: string;
}

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
 * Server Core's narrow persistence port. Protocol orchestration never imports the SQLite implementation or reaches into
 * authoritative domain tables through this boundary.
 */
export interface ProtocolRecoveryState {
    appendEvent(
        stateEpoch: string,
        event: DurableServerEvent,
        createdAt?: number,
    ): ProtocolEventEnvelope;
    changefeedBounds(stateEpoch: string): { count: number; earliest: number; latest: number };
    eventsAfter(stateEpoch: string, afterSequence: number): ProtocolEventEnvelope[];
    getReceipt(
        stateEpoch: string,
        clientId: string,
        requestId: string,
    ): StoredProtocolCommandReceipt | undefined;
    identity(now?: number): DurableProtocolIdentity;
    inspect(): { changefeedEntries: number; commandReceipts: number };
    saveReceipt(input: NewProtocolCommandReceipt): StoredProtocolCommandReceipt;
}
