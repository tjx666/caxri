import type {
    DurableCommandReceiptStore,
    DurableServerEvent,
    ProtocolEventEnvelope,
} from '@caxri/protocol';

export interface DurableProtocolIdentity {
    serverId: string;
    stateEpoch: string;
}

/**
 * Server Core's narrow persistence port. Protocol orchestration never imports the SQLite implementation or reaches into
 * authoritative domain tables through this boundary.
 */
export interface ProtocolRecoveryState extends DurableCommandReceiptStore {
    appendEvent(
        stateEpoch: string,
        event: DurableServerEvent,
        createdAt?: number,
    ): ProtocolEventEnvelope;
    changefeedBounds(stateEpoch: string): { count: number; earliest: number; latest: number };
    eventsAfter(stateEpoch: string, afterSequence: number): ProtocolEventEnvelope[];
    identity(now?: number): DurableProtocolIdentity;
    inspect(): { changefeedEntries: number; commandReceipts: number };
}
