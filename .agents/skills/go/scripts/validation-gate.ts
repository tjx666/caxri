import { z } from 'zod';

import type { MutationLease } from './mutation-lease';
import { acquireMutationLease, releaseMutationLease } from './mutation-lease';

const validationLogPathSchema = z
    .string()
    .min(1)
    .refine(
        (path) =>
            !path.startsWith('/') &&
            !path.includes('\\') &&
            !path.split('/').includes('..') &&
            (path.startsWith('validation/') || path.startsWith('ci-artifacts/')),
        'Validation logs must stay under validation/ or ci-artifacts/',
    );

export const validationKindSchema = z.enum(['ci', 'evidence', 'fixture', 'gates', 'remote_state']);
const validationResultSchema = z.enum(['pending', 'passed', 'failed']);

const validationRecordSchema = z.object({
    attempt: z.number().int().positive(),
    command: z.string().min(1),
    completedAt: z.string().nullable(),
    exitCode: z.number().int().nullable(),
    headSha: z.string().min(1),
    id: z.string().min(1),
    integrityError: z.string().min(1).nullable().default(null),
    kind: validationKindSchema,
    lineageId: z.string().min(1),
    logPath: validationLogPathSchema,
    result: validationResultSchema,
    sessionId: z.string().min(1),
    sourceFingerprint: z.string().min(1).default('legacy-unavailable'),
    startedAt: z.string(),
});

export const validationsSchema = z.array(validationRecordSchema);
export type ValidationRecord = z.infer<typeof validationRecordSchema>;

interface ValidationContext {
    mutationLease: MutationLease;
    runBudget: {
        policy: { validationRepairLimit: number };
        repairStops: Array<{ at: string; lineageId: string; reason: string }>;
    };
    validations: ValidationRecord[];
}

interface StartValidationInput {
    command: string;
    headSha: string;
    kind: z.infer<typeof validationKindSchema>;
    lineageId: string;
    logPath: string;
    sessionId: string;
    sourceFingerprint: string;
}

export function startValidation(
    state: ValidationContext,
    input: StartValidationInput,
    startedAt = new Date().toISOString(),
): ValidationRecord {
    const lineage = state.validations.filter(({ lineageId }) => lineageId === input.lineageId);
    const exactHeadCommand = state.validations.filter(
        ({ command, headSha }) => command === input.command && headSha === input.headSha,
    );
    const hasPassed = exactHeadCommand.some(({ result }) => result === 'passed');
    if (hasPassed)
        throw new Error('A passed exact-head validation cannot be rerun without invalidation');
    const pending =
        exactHeadCommand.find(({ result }) => result === 'pending') ??
        lineage.find(({ result }) => result === 'pending');
    if (pending) {
        throw new Error(
            `Validation ${pending.id} is still pending; recover its final result first`,
        );
    }
    const attempt = lineage.length + 1;
    if (attempt > state.runBudget.policy.validationRepairLimit) {
        throw new Error('Validation repair budget exhausted for this failure lineage');
    }
    const id = `validation-${String(state.validations.length + 1).padStart(3, '0')}`;
    const record = validationRecordSchema.parse({
        ...input,
        attempt,
        completedAt: null,
        exitCode: null,
        id,
        integrityError: null,
        result: 'pending',
        startedAt,
    });
    acquireMutationLease(state, { holderId: id, kind: 'validation' }, startedAt);
    state.validations.push(record);
    return record;
}

export function completeValidation(
    state: ValidationContext,
    input: {
        clean: boolean;
        exitCode: number;
        headSha: string;
        id: string;
        sourceFingerprint: string;
    },
    completedAt = new Date().toISOString(),
): ValidationRecord {
    const record = state.validations.find(({ id }) => id === input.id);
    if (!record) throw new Error(`Unknown validation: ${input.id}`);
    if (record.result !== 'pending') throw new Error(`Validation ${input.id} is already complete`);
    if (state.mutationLease?.kind !== 'validation' || state.mutationLease.holderId !== record.id) {
        throw new Error(`Validation ${input.id} does not own the worktree mutation lease`);
    }
    const integrityError =
        input.headSha !== record.headSha
            ? `Validation HEAD changed from ${record.headSha} to ${input.headSha}`
            : !input.clean || input.sourceFingerprint !== record.sourceFingerprint
              ? 'Validation source fingerprint changed while the command was running'
              : null;
    record.completedAt = completedAt;
    record.exitCode = input.exitCode;
    record.integrityError = integrityError;
    record.result = !integrityError && input.exitCode === 0 ? 'passed' : 'failed';
    if (
        record.result === 'failed' &&
        record.attempt >= state.runBudget.policy.validationRepairLimit &&
        state.runBudget.repairStops.every(({ lineageId }) => lineageId !== record.lineageId)
    ) {
        state.runBudget.repairStops.push({
            at: completedAt,
            lineageId: record.lineageId,
            reason: 'Validation repair budget exhausted without a passing exact-head receipt',
        });
    }
    releaseMutationLease(state, { holderId: record.id, kind: 'validation' });
    return record;
}
