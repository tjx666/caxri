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
export const validationTerminationSchema = z.enum([
    'caller_interrupt',
    'exit',
    'legacy',
    'runner_error',
    'runner_lost',
    'signal',
    'spawn_error',
]);
const validationResultSchema = z.enum(['pending', 'passed', 'failed']);

export const validationRecordSchema = z.object({
    arguments: z.array(z.string()).default([]),
    artifactVersion: z.union([z.literal(0), z.literal(1)]).default(0),
    attempt: z.number().int().positive(),
    childPid: z.number().int().positive().nullable().default(null),
    command: z.string().min(1),
    completedAt: z.string().nullable(),
    durationMs: z.number().int().nonnegative().nullable().default(null),
    executable: z.string().min(1).nullable().default(null),
    exitCode: z.number().int().nullable(),
    headSha: z.string().min(1),
    id: z.string().min(1),
    integrityError: z.string().min(1).nullable().default(null),
    kind: validationKindSchema,
    lineageId: z.string().min(1),
    logByteLength: z.number().int().nonnegative().nullable().default(null),
    logError: z.string().min(1).nullable().default(null),
    logIntegrityError: z.string().min(1).nullable().default(null),
    logMetadata: z
        .object({
            ctimeMs: z.number().nonnegative(),
            device: z.number().int().nonnegative(),
            inode: z.number().int().nonnegative(),
            mtimeMs: z.number().nonnegative(),
        })
        .nullable()
        .default(null),
    logPath: validationLogPathSchema,
    logSha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/u)
        .nullable()
        .default(null),
    result: validationResultSchema,
    runnerPid: z.number().int().positive().nullable().default(null),
    sessionId: z.string().min(1),
    signal: z.string().min(1).nullable().default(null),
    sourceFingerprint: z.string().min(1).default('legacy-unavailable'),
    startedAt: z.string(),
    termination: validationTerminationSchema.nullable().default(null),
});

export const validationsSchema = z.array(validationRecordSchema);
export type ValidationRecord = z.infer<typeof validationRecordSchema>;
export type ValidationKind = z.infer<typeof validationKindSchema>;
export type ValidationTermination = z.infer<typeof validationTerminationSchema>;

interface ValidationContext {
    mutationLease: MutationLease;
    runBudget: {
        policy: { validationRepairLimit: number };
        repairStops: Array<{ at: string; lineageId: string; reason: string }>;
    };
    validations: ValidationRecord[];
}

interface StartValidationInput {
    arguments?: string[];
    artifactVersion?: 0 | 1;
    command: string;
    executable?: string;
    headSha: string;
    kind: z.infer<typeof validationKindSchema>;
    lineageId: string;
    logPath?: string;
    runnerPid?: number;
    sessionId?: string;
    sourceFingerprint: string;
}

interface CompleteValidationInput {
    clean: boolean;
    durationMs?: number;
    exitCode: number | null;
    headSha: string;
    id: string;
    logByteLength?: number | null;
    logError?: string | null;
    logMetadata?: ValidationRecord['logMetadata'];
    logSha256?: string | null;
    signal?: string | null;
    sourceFingerprint: string;
    termination?: ValidationTermination;
}

function commandIdentity(record: {
    arguments?: string[];
    artifactVersion?: number;
    command: string;
    executable?: string | null;
}): string {
    return record.artifactVersion === 1 && record.executable
        ? JSON.stringify([record.executable, ...(record.arguments ?? [])])
        : record.command;
}

function isRepairAttemptConsumed(record: ValidationRecord): boolean {
    return record.termination !== 'caller_interrupt' && record.termination !== 'runner_lost';
}

/**
 * Derives the effective gate result from the execution receipt and its current artifact verification. Log checks can
 * therefore fail a previously passing record without rewriting the recorded process outcome.
 */
export function refreshValidationResult(record: ValidationRecord): ValidationRecord['result'] {
    if (record.completedAt === null) {
        record.result = 'pending';
    } else if (record.artifactVersion === 0) {
        record.result = !record.integrityError && record.exitCode === 0 ? 'passed' : 'failed';
    } else {
        record.result =
            !record.integrityError &&
            !record.logError &&
            !record.logIntegrityError &&
            record.termination === 'exit' &&
            record.exitCode === 0 &&
            record.logByteLength !== null &&
            record.logMetadata !== null &&
            record.logSha256 !== null
                ? 'passed'
                : 'failed';
    }
    return record.result;
}

export function startValidation(
    state: ValidationContext,
    input: StartValidationInput,
    startedAt = new Date().toISOString(),
): ValidationRecord {
    const inputIdentity = commandIdentity(input);
    const lineage = state.validations.filter(({ lineageId }) => lineageId === input.lineageId);
    const exactHeadCommand = state.validations.filter(
        (record) => commandIdentity(record) === inputIdentity && record.headSha === input.headSha,
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
    const attempt = lineage.filter(isRepairAttemptConsumed).length + 1;
    if (attempt > state.runBudget.policy.validationRepairLimit) {
        throw new Error('Validation repair budget exhausted for this failure lineage');
    }
    const id = `validation-${String(state.validations.length + 1).padStart(3, '0')}`;
    const record = validationRecordSchema.parse({
        ...input,
        arguments: input.arguments ?? [],
        artifactVersion: input.artifactVersion ?? 0,
        attempt,
        childPid: null,
        completedAt: null,
        durationMs: null,
        executable: input.executable ?? null,
        exitCode: null,
        id,
        integrityError: null,
        logByteLength: null,
        logError: null,
        logIntegrityError: null,
        logMetadata: null,
        logPath: input.logPath ?? `validation/${id}.log`,
        logSha256: null,
        result: 'pending',
        runnerPid: input.runnerPid ?? null,
        sessionId: input.sessionId ?? `${id}-pid-${input.runnerPid ?? 'legacy'}`,
        signal: null,
        startedAt,
        termination: null,
    });
    acquireMutationLease(state, { holderId: id, kind: 'validation' }, startedAt);
    state.validations.push(record);
    return record;
}

export function recordValidationChildPid(
    state: ValidationContext,
    id: string,
    runnerPid: number,
    childPid: number,
): ValidationRecord {
    const record = state.validations.find((validation) => validation.id === id);
    if (record?.result !== 'pending') throw new Error(`Unknown pending validation: ${id}`);
    if (record.runnerPid !== runnerPid)
        throw new Error(`Validation ${id} runner ownership changed`);
    if (state.mutationLease?.kind !== 'validation' || state.mutationLease.holderId !== id) {
        throw new Error(`Validation ${id} does not own the worktree mutation lease`);
    }
    record.childPid = childPid;
    return record;
}

export function completeValidation(
    state: ValidationContext,
    input: CompleteValidationInput,
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
    record.durationMs =
        input.durationMs ?? Math.max(0, Date.parse(completedAt) - Date.parse(record.startedAt));
    record.exitCode = input.exitCode;
    record.integrityError = integrityError;
    record.logByteLength = input.logByteLength ?? null;
    record.logError = input.logError ?? null;
    record.logIntegrityError = null;
    record.logMetadata = input.logMetadata ?? null;
    record.logSha256 = input.logSha256 ?? null;
    record.signal = input.signal ?? null;
    record.termination = input.termination ?? 'legacy';
    const result = refreshValidationResult(record);
    if (
        result === 'failed' &&
        isRepairAttemptConsumed(record) &&
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
