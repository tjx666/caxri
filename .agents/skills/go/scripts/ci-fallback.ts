import { z } from 'zod';

import { assertReviewHeadFrozen, type ReviewGate } from './review-gate';

export const ciFailureKindSchema = z.enum(['billing', 'infrastructure']);
export const ciFallbackResultSchema = z.enum(['passed', 'failed']);
export const PLATFORM_NEUTRAL_CI_COMMANDS = [
    'bun run lint',
    'bun run knip',
    'bun run doctor:changed',
    'bun run typecheck',
    'bun run format:check',
    'bun run format:md:check',
    'bun run test',
    'bun run build',
] as const;
const FULL_ELECTRON_E2E_COMMAND = 'bun run test:e2e';
export const BILLING_POLICY_AUTHORIZATION =
    'Explicit Go policy automatically authorizes exact-head local substitution for verified zero-step GitHub Actions billing failures.';
const BILLING_EVIDENCE_PATTERN = /billing|payment|spending limit|account payments/i;

const authorizationSchema = z.object({ at: z.string(), detail: z.string().min(1) });
const externalFailureSchema = z.object({
    detail: z.string().min(1),
    job: z.string().min(1),
    kind: ciFailureKindSchema,
    runUrl: z.url(),
    verifiedAt: z.string(),
    zeroSteps: z.literal(true),
});
const validationSchema = z.object({
    commands: z.array(z.string().min(1)).min(1),
    completedAt: z.string(),
    result: ciFallbackResultSchema,
});
const fullElectronE2eRunSchema = z.object({
    completedAt: z.string(),
    headSha: z.string().min(1),
    result: ciFallbackResultSchema,
});
export const validationBudgetSchema = z.object({
    fullElectronE2eRuns: z.array(fullElectronE2eRunSchema).max(2),
});

export const ciFallbackSchema = z.discriminatedUnion('status', [
    z.object({
        authorization: z.null(),
        electronE2e: z.null(),
        externalFailure: z.null(),
        headSha: z.null(),
        platformNeutral: z.null(),
        status: z.literal('not_requested'),
    }),
    z.object({
        authorization: authorizationSchema,
        electronE2e: z.null(),
        externalFailure: externalFailureSchema,
        headSha: z.string().min(1),
        platformNeutral: z.null(),
        status: z.literal('admitted'),
    }),
    z.object({
        authorization: authorizationSchema,
        electronE2e: validationSchema,
        externalFailure: externalFailureSchema,
        headSha: z.string().min(1),
        platformNeutral: validationSchema,
        status: z.enum(['passed', 'failed']),
    }),
]);

export type CiFallback = z.infer<typeof ciFallbackSchema>;
export type ValidationBudget = z.infer<typeof validationBudgetSchema>;
type CiFailureKind = z.infer<typeof ciFailureKindSchema>;
type CiFallbackResult = z.infer<typeof ciFallbackResultSchema>;

interface DeliveryContext {
    acceptance: { status: string };
    ciFallback: CiFallback;
    phase: string;
    pullRequest: { headSha: string | null; status: string };
    reviewGate: ReviewGate;
    validationBudget: ValidationBudget;
}

interface AdmissionInput {
    authorization?: string;
    failureDetail: string;
    failureJob: string;
    failureKind: CiFailureKind;
    failureRunUrl: string;
    headSha: string;
    verifiedZeroSteps: boolean;
}

interface ResultInput {
    electronE2eCommand: string;
    electronE2eResult: CiFallbackResult;
    headSha: string;
    platformCommands: string[];
    platformResult: CiFallbackResult;
}

export function createEmptyCiFallback(): CiFallback {
    return {
        authorization: null,
        electronE2e: null,
        externalFailure: null,
        headSha: null,
        platformNeutral: null,
        status: 'not_requested',
    };
}

export function createEmptyValidationBudget(): ValidationBudget {
    return { fullElectronE2eRuns: [] };
}

export function admitCiFallback(
    state: DeliveryContext,
    input: AdmissionInput,
    recordedAt = new Date().toISOString(),
): CiFallback {
    if (state.phase !== 'delivery') {
        throw new Error('Local CI fallback can be admitted only during delivery');
    }
    if (state.pullRequest.status !== 'checks_blocked') {
        throw new Error('Local CI fallback requires hosted checks to remain externally blocked');
    }
    if (state.ciFallback.status !== 'not_requested') {
        throw new Error(
            'Local CI fallback can run only once per PR head; push a new PR head before readmission',
        );
    }
    if (!state.pullRequest.headSha || state.pullRequest.headSha !== input.headSha) {
        throw new Error('Local CI fallback must target the exact current PR head');
    }
    assertReviewHeadFrozen(state, input.headSha);
    if (state.validationBudget.fullElectronE2eRuns.length >= 2) {
        throw new Error('A Go run can execute at most two full Electron E2E suites');
    }
    const previousE2e = state.validationBudget.fullElectronE2eRuns.at(-1);
    if (previousE2e?.result === 'passed' && state.acceptance.status !== 'rejected') {
        throw new Error(
            'A passed full Electron E2E run cannot be repeated unless human Acceptance rejected the delivered head',
        );
    }
    if (!input.verifiedZeroSteps) {
        throw new Error('Local CI fallback requires a verified zero-step hosted job failure');
    }
    const explicitAuthorization = input.authorization?.trim() ?? '';
    if (input.failureKind === 'infrastructure' && !explicitAuthorization) {
        throw new Error('Infrastructure local CI fallback requires explicit user authorization');
    }
    if (input.failureKind === 'billing' && !BILLING_EVIDENCE_PATTERN.test(input.failureDetail)) {
        throw new Error(
            'Billing fallback requires the original GitHub payment, billing, or spending-limit failure detail',
        );
    }
    const externalFailure = externalFailureSchema.parse({
        detail: input.failureDetail,
        job: input.failureJob,
        kind: input.failureKind,
        runUrl: input.failureRunUrl,
        verifiedAt: recordedAt,
        zeroSteps: true,
    });
    state.ciFallback = {
        authorization: {
            at: recordedAt,
            detail:
                explicitAuthorization ||
                `${BILLING_POLICY_AUTHORIZATION} GitHub evidence: ${input.failureDetail}`,
        },
        electronE2e: null,
        externalFailure,
        headSha: input.headSha,
        platformNeutral: null,
        status: 'admitted',
    };
    return state.ciFallback;
}

export function recordCiFallbackResult(
    state: DeliveryContext,
    input: ResultInput,
    recordedAt = new Date().toISOString(),
): CiFallback {
    if (state.phase !== 'delivery' || state.ciFallback.status !== 'admitted') {
        throw new Error('Local CI fallback results require an admitted delivery fallback');
    }
    if (
        !state.pullRequest.headSha ||
        state.pullRequest.headSha !== input.headSha ||
        state.ciFallback.headSha !== input.headSha
    ) {
        throw new Error('Local CI fallback results must target the exact admitted PR head');
    }
    if (
        input.platformCommands.length !== PLATFORM_NEUTRAL_CI_COMMANDS.length ||
        input.platformCommands.some(
            (command, index) => command !== PLATFORM_NEUTRAL_CI_COMMANDS[index],
        )
    ) {
        throw new Error('Local CI fallback must record the exact platform-neutral CI gates');
    }
    if (input.electronE2eCommand !== FULL_ELECTRON_E2E_COMMAND) {
        throw new Error('Local CI fallback must run one full isolated Electron E2E suite');
    }
    const platformNeutral = validationSchema.parse({
        commands: input.platformCommands,
        completedAt: recordedAt,
        result: input.platformResult,
    });
    const electronE2e = validationSchema.parse({
        commands: [input.electronE2eCommand],
        completedAt: recordedAt,
        result: input.electronE2eResult,
    });
    state.validationBudget.fullElectronE2eRuns.push({
        completedAt: recordedAt,
        headSha: input.headSha,
        result: electronE2e.result,
    });
    state.ciFallback = {
        authorization: state.ciFallback.authorization,
        electronE2e,
        externalFailure: state.ciFallback.externalFailure,
        headSha: input.headSha,
        platformNeutral,
        status:
            platformNeutral.result === 'passed' && electronE2e.result === 'passed'
                ? 'passed'
                : 'failed',
    };
    return state.ciFallback;
}

export function assertDeliveryCanAdvance(state: DeliveryContext): void {
    if (state.pullRequest.status === 'ready') return;
    if (
        state.pullRequest.status === 'checks_blocked' &&
        state.ciFallback.status === 'passed' &&
        state.pullRequest.headSha === state.ciFallback.headSha
    ) {
        return;
    }
    throw new Error(
        'Acceptance requires green hosted checks or a passed exact-head local CI fallback',
    );
}
