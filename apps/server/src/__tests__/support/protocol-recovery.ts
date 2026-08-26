import type { ProtocolEventEnvelope, StoredProtocolCommandReceipt } from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    durableServerEventSchema,
    protocolEventEnvelopeSchema,
} from '@caxri/protocol';

import type { ProtocolRecoveryState } from '../../domains/protocol-recovery';

export function createTestProtocolRecoveryState(): ProtocolRecoveryState {
    const identity = {
        serverId: 'a'.repeat(32),
        stateEpoch: 'b'.repeat(32),
    };
    const receipts = new Map<string, StoredProtocolCommandReceipt>();
    const events: ProtocolEventEnvelope[] = [];
    const receiptKey = (clientId: string, requestId: string): string =>
        `${identity.stateEpoch}:${clientId}:${requestId}`;
    return {
        appendEvent(stateEpoch, event) {
            if (stateEpoch !== identity.stateEpoch) throw new Error('Unexpected test State Epoch');
            const envelope = protocolEventEnvelopeSchema.parse({
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                cursor: events.length + 1,
                event: durableServerEventSchema.parse(event),
            });
            events.push(envelope);
            return envelope;
        },
        changefeedBounds: () => ({
            count: events.length,
            earliest: events.at(0)?.cursor ?? 0,
            latest: events.at(-1)?.cursor ?? 0,
        }),
        eventsAfter: (_stateEpoch, afterSequence) =>
            events.filter(({ cursor }) => cursor > afterSequence),
        getReceipt: (_stateEpoch, clientId, requestId) =>
            receipts.get(receiptKey(clientId, requestId)),
        identity: () => identity,
        inspect: () => ({
            changefeedEntries: events.length,
            commandReceipts: receipts.size,
        }),
        saveReceipt(input) {
            const receipt = { ...input };
            receipts.set(receiptKey(input.clientId, input.requestId), receipt);
            return receipt;
        },
    };
}
