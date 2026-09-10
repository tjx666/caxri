import {
    agentDelegationAnswerSchema,
    agentDelegationCreateSchema,
    agentDelegationReceiptSchema,
    agentLaunchSettingsSchema,
    CaxriError,
    principalSchema,
} from '@caxri/protocol';
import { eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { CaxriDrizzleDatabase } from '../connection';
import { agentDelegations } from '../schema';

const activeStatuses = [
    'requested',
    'launching',
    'awaiting_ready',
    'submitting',
    'running',
    'collecting',
    'blocked',
];

const storedDelegationSchema = z.strictObject({
    receipt: agentDelegationReceiptSchema,
    principal: principalSchema,
    input: agentDelegationCreateSchema,
    fingerprint: z.string(),
    promptDigest: z.string(),
    frozenLaunch: agentLaunchSettingsSchema,
    launchId: z.string().optional(),
    providerSessionId: z.string().optional(),
    turnId: z.string().optional(),
    responseDigest: z.string().optional(),
    transcriptOffset: z.number().int().nonnegative().optional(),
    answer: agentDelegationAnswerSchema.optional(),
});

export type StoredAgentDelegation = z.infer<typeof storedDelegationSchema>;

/**
 * Bounded private task storage. Admission refuses capacity rather than silently discarding unclaimed answers.
 */
export class AgentDelegationsModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    get(id: string): StoredAgentDelegation | undefined {
        const row = this.database
            .select()
            .from(agentDelegations)
            .where(eq(agentDelegations.id, id))
            .get();
        return row ? storedDelegationSchema.parse(JSON.parse(row.recordJson)) : undefined;
    }

    insert(record: StoredAgentDelegation): StoredAgentDelegation {
        const count = this.database
            .select({ value: sql<number>`count(*)` })
            .from(agentDelegations)
            .get()!.value;
        if (count >= 1024) throw new CaxriError('CAPACITY', 'Too many saved Agent delegations');
        const parsed = storedDelegationSchema.parse(record);
        this.database
            .insert(agentDelegations)
            .values({
                id: parsed.receipt.delegationId,
                sessionId: parsed.receipt.sessionId,
                status: parsed.receipt.status,
                recordJson: JSON.stringify(parsed),
            })
            .run();
        return parsed;
    }

    save(record: StoredAgentDelegation): StoredAgentDelegation {
        const parsed = storedDelegationSchema.parse(record);
        const result = this.database
            .update(agentDelegations)
            .set({ status: parsed.receipt.status, recordJson: JSON.stringify(parsed) })
            .where(eq(agentDelegations.id, parsed.receipt.delegationId))
            .run();
        if (result.changes !== 1)
            throw new CaxriError('NOT_FOUND', 'Agent delegation is unavailable');
        return parsed;
    }

    active(): StoredAgentDelegation[] {
        return this.database
            .select()
            .from(agentDelegations)
            .where(inArray(agentDelegations.status, activeStatuses))
            .all()
            .map((row) => storedDelegationSchema.parse(JSON.parse(row.recordJson)));
    }
}
