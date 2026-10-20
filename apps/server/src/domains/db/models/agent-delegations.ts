import type { AgentDelegationReceipt } from '@caxri/protocol';
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

/**
 * Whether a task in `status` is still in flight: not yet settled as completed, failed, or stopped.
 */
export function isActiveDelegationStatus(status: string): boolean {
    return activeStatuses.includes(status);
}

const storedDelegationSchema = z.strictObject({
    receipt: agentDelegationReceiptSchema,
    principal: principalSchema,
    input: agentDelegationCreateSchema,
    fingerprint: z.string(),
    promptDigest: z.string(),
    frozenLaunch: agentLaunchSettingsSchema,
    frozenInstructions: z.string().max(8192).optional(),
    launchId: z.string().optional(),
    providerSessionId: z.string().optional(),
    turnId: z.string().optional(),
    responseDigest: z.string().optional(),
    responseByteLength: z.number().int().nonnegative().optional(),
    responseStopCount: z.number().int().nonnegative().optional(),
    responseOverflow: z.boolean().optional(),
    transcriptOffset: z.number().int().nonnegative().optional(),
    answer: agentDelegationAnswerSchema.optional(),
    rootDelegationId: z.string().optional(),
    nextDelegationId: z.string().optional(),
    inputEpoch: z.number().int().nonnegative().optional(),
    hasHumanIntervention: z.boolean().optional(),
    hasLostTarget: z.boolean().optional(),
    continuationPromptDigests: z
        .array(z.string().regex(/^[\da-f]{64}$/u))
        .max(64)
        .optional(),
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

    /**
     * Child task IDs name files inside their root task, never independently owned top-level directories.
     */
    storageRootsForSessions(sessionIds: readonly string[]): string[] {
        if (sessionIds.length === 0) return [];
        const rows = this.database
            .select({ recordJson: agentDelegations.recordJson })
            .from(agentDelegations)
            .where(inArray(agentDelegations.sessionId, [...sessionIds]))
            .all();
        return [
            ...new Set(
                rows.map((row) => {
                    const record = storedDelegationSchema.parse(JSON.parse(row.recordJson));
                    return record.rootDelegationId ?? record.receipt.delegationId;
                }),
            ),
        ];
    }

    /**
     * Receipts only: callers that summarize tasks never need their private prompt, launch, or answer.
     */
    receiptsForSessions(sessionIds: readonly string[]): AgentDelegationReceipt[] {
        if (sessionIds.length === 0) return [];
        return this.database
            .select({ recordJson: agentDelegations.recordJson })
            .from(agentDelegations)
            .where(inArray(agentDelegations.sessionId, [...sessionIds]))
            .all()
            .map((row) => storedDelegationSchema.parse(JSON.parse(row.recordJson)).receipt);
    }

    forTerminal(terminalId: string): StoredAgentDelegation[] {
        return this.database
            .select()
            .from(agentDelegations)
            .where(eq(agentDelegations.terminalId, terminalId))
            .all()
            .map((row) => storedDelegationSchema.parse(JSON.parse(row.recordJson)));
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
                terminalId: parsed.receipt.terminalId,
                recordJson: JSON.stringify(parsed),
            })
            .run();
        return parsed;
    }

    save(record: StoredAgentDelegation): StoredAgentDelegation {
        const parsed = storedDelegationSchema.parse(record);
        const result = this.database
            .update(agentDelegations)
            .set({
                status: parsed.receipt.status,
                terminalId: parsed.receipt.terminalId,
                recordJson: JSON.stringify(parsed),
            })
            .where(eq(agentDelegations.id, parsed.receipt.delegationId))
            .run();
        if (result.changes !== 1)
            throw new CaxriError('NOT_FOUND', 'Agent delegation is unavailable');
        return parsed;
    }

    /**
     * Every saved task, for a caller's own task list. Bounded by the insert capacity, so a full scan stays small.
     */
    all(): StoredAgentDelegation[] {
        return this.database
            .select()
            .from(agentDelegations)
            .all()
            .map((row) => storedDelegationSchema.parse(JSON.parse(row.recordJson)));
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
