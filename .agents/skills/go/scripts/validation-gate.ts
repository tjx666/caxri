import { z } from 'zod';

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

export const validationRecordSchema = z.object({
    attempt: z.number().int().positive(),
    command: z.string().min(1),
    completedAt: z.string().nullable(),
    exitCode: z.number().int().nullable(),
    headSha: z.string().min(1),
    id: z.string().min(1),
    kind: validationKindSchema,
    lineageId: z.string().min(1),
    logPath: validationLogPathSchema,
    result: validationResultSchema,
    sessionId: z.string().min(1),
    startedAt: z.string(),
});

export const validationsSchema = z.array(validationRecordSchema);
export type ValidationRecord = z.infer<typeof validationRecordSchema>;

interface ValidationContext {
    runBudget: { policy: { validationRepairLimit: number } };
    validations: ValidationRecord[];
}

interface StartValidationInput {
    command: string;
    headSha: string;
    kind: z.infer<typeof validationKindSchema>;
    lineageId: string;
    logPath: string;
    sessionId: string;
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
    const passed = exactHeadCommand.find(({ result }) => result === 'passed');
    if (passed)
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
    const record = validationRecordSchema.parse({
        ...input,
        attempt,
        completedAt: null,
        exitCode: null,
        id: `validation-${String(state.validations.length + 1).padStart(3, '0')}`,
        result: 'pending',
        startedAt,
    });
    state.validations.push(record);
    return record;
}

export function completeValidation(
    state: ValidationContext,
    input: { exitCode: number; id: string },
    completedAt = new Date().toISOString(),
): ValidationRecord {
    const record = state.validations.find(({ id }) => id === input.id);
    if (!record) throw new Error(`Unknown validation: ${input.id}`);
    if (record.result !== 'pending') throw new Error(`Validation ${input.id} is already complete`);
    record.completedAt = completedAt;
    record.exitCode = input.exitCode;
    record.result = input.exitCode === 0 ? 'passed' : 'failed';
    return record;
}
