import type { DurableCommandReceiptStore, DurableEventStore } from '@caxri/protocol';

export interface DurableProtocolIdentity {
    serverId: string;
    stateEpoch: string;
}

/**
 * Server Core's narrow persistence port. Protocol orchestration never imports the SQLite implementation or reaches into
 * authoritative domain tables through this boundary.
 */
export interface ProtocolRecoveryState extends DurableCommandReceiptStore, DurableEventStore {
    identity(now?: number): DurableProtocolIdentity;
    inspect(): { changefeedEntries: number; commandReceipts: number };
}
