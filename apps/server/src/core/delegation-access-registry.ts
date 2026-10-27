import { Buffer } from 'node:buffer';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type { CommandExecutionContext, Principal } from '@caxri/protocol';
import { CaxriError, delegationProviderSchema } from '@caxri/protocol';
import { z } from 'zod';

import type { DelegationClientStore } from '../domains/db';

const accessRecordSchema = z.strictObject({
    clientId: z.uuid(),
    generation: z.number().int().positive(),
    projectId: z.string().min(1),
    sessionId: z.string().min(1),
    callerProvider: delegationProviderSchema,
    tokenDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    revokedAt: z.number().int().positive().optional(),
});
const accessRecordsSchema = z.array(accessRecordSchema).max(128);
type AccessRecord = z.infer<typeof accessRecordSchema>;
type AccessBinding = Pick<AccessRecord, 'projectId' | 'sessionId' | 'callerProvider'>;
type ExternalPrincipal = Extract<Principal, { kind: 'delegation-client' }>;

function digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

function summary(record: AccessRecord) {
    return accessRecordSchema.omit({ tokenDigest: true }).strip().parse(record);
}

/**
 * Durable, revocable external identities; no profile-owner secret or synthetic managed Terminal is borrowed.
 */
export class DelegationAccessRegistry {
    static open(store: DelegationClientStore, now: () => number = Date.now) {
        const parsed = accessRecordsSchema.safeParse(store.load());
        if (!parsed.success)
            throw new CaxriError('VALIDATION', 'Delegation access registry is malformed');
        return new DelegationAccessRegistry(store, parsed.data, now);
    }

    private records: Map<string, AccessRecord>;
    private writeTail = Promise.resolve();

    private constructor(
        private readonly store: DelegationClientStore,
        records: AccessRecord[],
        private readonly now: () => number,
    ) {
        this.records = new Map(records.map((record) => [record.clientId, record]));
        if (this.records.size !== records.length)
            throw new CaxriError('VALIDATION', 'Delegation access registry has duplicate clients');
    }

    private async mutate<T>(change: (records: Map<string, AccessRecord>) => T): Promise<T> {
        const previous = this.writeTail;
        const operation = (async () => {
            await previous;
            const records = new Map(this.records);
            const result = change(records);
            this.store.write(accessRecordsSchema.parse(records.values().toArray()));
            this.records = records;
            return result;
        })();
        this.writeTail = (async () => {
            try {
                await operation;
            } catch {
                /*
                A failed write must release subsequent mutations.
                */
            }
        })();
        return operation;
    }

    private current(clientId: string, generation: number): AccessRecord {
        const record = this.records.get(clientId);
        if (
            !record ||
            record.generation !== generation ||
            record.revokedAt !== undefined ||
            record.expiresAt <= this.now()
        )
            throw new CaxriError('FORBIDDEN', 'Delegation client is expired or revoked');
        return record;
    }

    private context(record: AccessRecord): CommandExecutionContext {
        return {
            capabilities: ['agents.delegate'],
            principal: {
                kind: 'delegation-client',
                id: `delegation-client:${record.clientId}`,
                clientId: record.clientId,
                generation: record.generation,
                projectIds: [record.projectId],
                sessionId: record.sessionId,
                callerProvider: record.callerProvider,
            },
        };
    }

    async create(binding: AccessBinding, ttlMs: number) {
        if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 604_800_000)
            throw new CaxriError(
                'VALIDATION',
                'Delegation access lifetime must be between one minute and seven days',
            );
        return this.mutate((records) => {
            for (const [id, record] of records)
                if (record.revokedAt !== undefined || record.expiresAt <= this.now())
                    records.delete(id);
            if (records.size >= 128)
                throw new CaxriError('CAPACITY', 'Delegation access registry is full');
            const token = randomBytes(32).toString('hex');
            const createdAt = this.now();
            const record = accessRecordSchema.parse({
                ...binding,
                clientId: randomUUID(),
                generation: 1,
                tokenDigest: digest(token),
                createdAt,
                expiresAt: createdAt + ttlMs,
            });
            records.set(record.clientId, record);
            return { ...summary(record), token };
        });
    }

    list() {
        return this.records.values().map(summary).toArray();
    }

    async revoke(clientId: string, generation: number) {
        return this.mutate((records) => {
            const record = records.get(clientId);
            if (!record) throw new CaxriError('NOT_FOUND', 'Delegation client not found');
            if (record.generation !== generation || record.revokedAt !== undefined)
                throw new CaxriError('CONFLICT', 'Delegation client changed before revocation');
            const updated = {
                ...record,
                generation: record.generation + 1,
                tokenDigest: digest(randomBytes(32).toString('hex')),
                revokedAt: this.now(),
            };
            records.set(clientId, updated);
            return summary(updated);
        });
    }

    authenticate(credential: {
        clientId: string;
        generation: number;
        token: string;
    }): CommandExecutionContext {
        const record = this.current(credential.clientId, credential.generation);
        if (
            !timingSafeEqual(
                Buffer.from(digest(credential.token), 'hex'),
                Buffer.from(record.tokenDigest, 'hex'),
            )
        )
            throw new CaxriError('FORBIDDEN', 'Delegation client credential is invalid');
        return this.context(record);
    }

    /**
     * Checked before dispatcher receipt lookup, so a cached reply never bypasses expiry or revocation.
     */
    refresh(principal: ExternalPrincipal): CommandExecutionContext {
        return this.context(this.current(principal.clientId, principal.generation));
    }
}
