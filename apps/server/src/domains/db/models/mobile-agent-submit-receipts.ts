import { CaxriError } from '@caxri/protocol';
import { and, eq, lt, or, sql } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { mobileAgentSubmitReceipts } from '../schema';

const MAX_RECEIPTS = 2_048;
const ACCEPTED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const UNKNOWN_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface MobileSubmitIdentity {
    deviceId: string;
    deviceGeneration: number;
    clientMutationId: string;
    requestFingerprint: string;
}

/**
 * A client never retries automatically, but a stable mutation ID can be submitted again after an ambiguous response or
 * Server restart. Reserve before the PTY effect and retain only a fingerprint and status: no message text, Terminal
 * output, or transcript enters this table. Expiry defines a bounded dedupe window.
 */
export class MobileAgentSubmitReceiptsModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    find(identity: MobileSubmitIdentity): 'accepted' | 'unknown' | undefined {
        const existing = this.database
            .select()
            .from(mobileAgentSubmitReceipts)
            .where(
                and(
                    eq(mobileAgentSubmitReceipts.deviceId, identity.deviceId),
                    eq(mobileAgentSubmitReceipts.deviceGeneration, identity.deviceGeneration),
                    eq(mobileAgentSubmitReceipts.clientMutationId, identity.clientMutationId),
                ),
            )
            .get();
        if (!existing) return undefined;
        if (existing.requestFingerprint !== identity.requestFingerprint)
            throw new CaxriError('CONFLICT', 'Mobile submission ID was reused for another message');
        return existing.status === 'accepted' ? 'accepted' : 'unknown';
    }

    reserve(identity: MobileSubmitIdentity, now = Date.now()): 'reserved' | 'accepted' | 'unknown' {
        return this.database.transaction((transaction) => {
            const key = and(
                eq(mobileAgentSubmitReceipts.deviceId, identity.deviceId),
                eq(mobileAgentSubmitReceipts.deviceGeneration, identity.deviceGeneration),
                eq(mobileAgentSubmitReceipts.clientMutationId, identity.clientMutationId),
            );
            const existing = transaction.select().from(mobileAgentSubmitReceipts).where(key).get();
            if (existing) {
                if (existing.requestFingerprint !== identity.requestFingerprint)
                    throw new CaxriError(
                        'CONFLICT',
                        'Mobile submission ID was reused for another message',
                    );
                return existing.status === 'accepted' ? 'accepted' : 'unknown';
            }
            const expiredAccepted = and(
                eq(mobileAgentSubmitReceipts.status, 'accepted'),
                lt(mobileAgentSubmitReceipts.createdAt, now - ACCEPTED_RETENTION_MS),
            );
            const expiredUnknown = and(
                eq(mobileAgentSubmitReceipts.status, 'reserved'),
                lt(mobileAgentSubmitReceipts.createdAt, now - UNKNOWN_RETENTION_MS),
            );
            transaction
                .delete(mobileAgentSubmitReceipts)
                .where(or(expiredAccepted, expiredUnknown))
                .run();
            const count = transaction
                .select({ value: sql<number>`count(*)` })
                .from(mobileAgentSubmitReceipts)
                .get()!.value;
            if (count >= MAX_RECEIPTS)
                throw new CaxriError('CAPACITY', 'Mobile submission receipts are full');
            transaction
                .insert(mobileAgentSubmitReceipts)
                .values({
                    ...identity,
                    status: 'reserved',
                    createdAt: now,
                })
                .run();
            return 'reserved';
        });
    }

    markAccepted(identity: MobileSubmitIdentity): void {
        const changed = this.database
            .update(mobileAgentSubmitReceipts)
            .set({ status: 'accepted' })
            .where(
                and(
                    eq(mobileAgentSubmitReceipts.deviceId, identity.deviceId),
                    eq(mobileAgentSubmitReceipts.deviceGeneration, identity.deviceGeneration),
                    eq(mobileAgentSubmitReceipts.clientMutationId, identity.clientMutationId),
                    eq(mobileAgentSubmitReceipts.requestFingerprint, identity.requestFingerprint),
                    eq(mobileAgentSubmitReceipts.status, 'reserved'),
                ),
            )
            .run().changes;
        if (changed !== 1)
            throw new CaxriError('INTERNAL', 'Mobile submission receipt was not reserved');
    }

    /**
     * Safe only when the caller proved Host accepted zero bytes.
     */
    removeRejected(identity: MobileSubmitIdentity): void {
        this.database
            .delete(mobileAgentSubmitReceipts)
            .where(
                and(
                    eq(mobileAgentSubmitReceipts.deviceId, identity.deviceId),
                    eq(mobileAgentSubmitReceipts.deviceGeneration, identity.deviceGeneration),
                    eq(mobileAgentSubmitReceipts.clientMutationId, identity.clientMutationId),
                    eq(mobileAgentSubmitReceipts.requestFingerprint, identity.requestFingerprint),
                    eq(mobileAgentSubmitReceipts.status, 'reserved'),
                ),
            )
            .run();
    }
}
