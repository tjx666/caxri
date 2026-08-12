import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { assertIssueExpectationDriftReady, type IssueExpectationDrift } from './issue-drift';

const finalIssueSchema = z.object({
    number: z.number().int().positive(),
    projectStatus: z.literal('Done'),
    state: z.literal('CLOSED'),
});

export const finalizationSchema = z.object({
    deliveredAt: z.string().nullable(),
    headSha: z.string().min(1),
    issues: z
        .array(finalIssueSchema)
        .min(1)
        .refine(
            (issues) => new Set(issues.map(({ number }) => number)).size === issues.length,
            'Finalization issue evidence must not contain duplicates',
        ),
    mergeSha: z.string().min(1),
    path: z.literal('finalization.json'),
    pullRequestNumber: z.number().int().positive(),
    verifiedAt: z.string(),
});

export type FinalizationReceipt = z.infer<typeof finalizationSchema>;

interface FinalizationContext {
    acceptance: { acceptedHeadSha: string | null; status: string; waivedHeadSha?: string | null };
    finalization: FinalizationReceipt | null;
    handoffReport: { deliveredAt: string | null; headSha: string } | null;
    issues: Array<{
        commits: string[];
        expectationDrift: IssueExpectationDrift;
        number: number;
        status: string;
    }>;
    phase: string;
    pullRequest: { headSha: string | null; number: number | null; status: string };
}

function assertFinalizationDriftReady(state: FinalizationContext, headSha: string): void {
    for (const issue of state.issues.filter(({ status }) => status !== 'deferred')) {
        assertIssueExpectationDriftReady(issue, headSha);
    }
}

export async function generateFinalization(
    state: FinalizationContext,
    runDirectory: string,
    input: {
        headSha: string;
        issues: Array<{ number: number; projectStatus: 'Done'; state: 'CLOSED' }>;
        mergeSha: string;
    },
    verifiedAt = new Date().toISOString(),
): Promise<FinalizationReceipt> {
    if (state.phase !== 'finalization') {
        throw new Error('Finalization evidence can be generated only during finalization');
    }
    const decisionHead =
        state.acceptance.status === 'waived'
            ? state.acceptance.waivedHeadSha
            : state.acceptance.acceptedHeadSha;
    if (
        state.pullRequest.status !== 'merged' ||
        !state.pullRequest.number ||
        state.pullRequest.headSha !== input.headSha ||
        decisionHead !== input.headSha
    ) {
        throw new Error(
            'Finalization requires the exact accepted or explicitly waived merged head',
        );
    }
    if (input.issues.length === 0) throw new Error('Finalization requires intended issue evidence');
    const intendedIssues = state.issues
        .filter(({ status }) => status !== 'deferred')
        .map(({ number, status }) => ({ number, status }))
        .sort((a, b) => a.number - b.number);
    if (intendedIssues.some(({ status }) => status !== 'complete')) {
        throw new Error('Finalization requires every intended ledger issue to be complete');
    }
    assertFinalizationDriftReady(state, input.headSha);
    const suppliedNumbers = input.issues.map(({ number }) => number).sort((a, b) => a - b);
    if (
        JSON.stringify(suppliedNumbers) !==
        JSON.stringify(intendedIssues.map(({ number }) => number))
    ) {
        throw new Error('Finalization issue evidence must match every intended ledger issue');
    }
    const receipt = finalizationSchema.parse({
        deliveredAt: null,
        headSha: input.headSha,
        issues: input.issues,
        mergeSha: input.mergeSha,
        path: 'finalization.json',
        pullRequestNumber: state.pullRequest.number,
        verifiedAt,
    });
    const path = join(runDirectory, 'finalization.json');
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
    state.finalization = receipt;
    return receipt;
}

export async function recordFinalizationDelivery(
    state: FinalizationContext,
    runDirectory: string,
    deliveredAt = new Date().toISOString(),
): Promise<FinalizationReceipt> {
    if (state.phase !== 'finalization') {
        throw new Error('Finalization can be delivered only during finalization');
    }
    if (!state.finalization) throw new Error('Finalization receipt has not been generated');
    assertFinalizationDriftReady(state, state.finalization.headSha);
    state.finalization.deliveredAt = deliveredAt;
    const path = join(runDirectory, state.finalization.path);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state.finalization, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
    return state.finalization;
}

export function assertFinalizationComplete(state: FinalizationContext): void {
    if (!state.handoffReport?.deliveredAt) {
        throw new Error('Completion requires the delivered handoff report');
    }
    if (!state.finalization?.deliveredAt) {
        throw new Error('Completion requires the delivered finalization receipt');
    }
    assertFinalizationDriftReady(state, state.finalization.headSha);
    if (state.finalization.headSha !== state.handoffReport.headSha) {
        throw new Error('Finalization and handoff report must bind the same exact head');
    }
    if (
        state.pullRequest.status !== 'merged' ||
        state.pullRequest.number !== state.finalization.pullRequestNumber ||
        state.pullRequest.headSha !== state.finalization.headSha
    ) {
        throw new Error(
            'Completion requires finalization for the exact remotely merged pull request',
        );
    }
    const intendedIssueNumbers = state.issues
        .filter(({ status }) => status !== 'deferred')
        .map(({ number }) => number)
        .sort((a, b) => a - b);
    const finalizedIssueNumbers = state.finalization.issues
        .map(({ number }) => number)
        .sort((a, b) => a - b);
    if (
        JSON.stringify(intendedIssueNumbers) !== JSON.stringify(finalizedIssueNumbers) ||
        state.issues.some(({ status }) => status !== 'complete' && status !== 'deferred')
    ) {
        throw new Error('Completion requires finalization for every intended completed issue');
    }
}

export async function verifyFinalizationArtifact(
    state: FinalizationContext,
    runDirectory: string,
): Promise<boolean> {
    if (!state.finalization) return false;
    const path = join(runDirectory, state.finalization.path);
    const metadata = await lstat(path).catch(() => {
        throw new Error('Persisted finalization receipt is missing');
    });
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error('Persisted finalization receipt must be a direct regular file');
    }
    const raw = await readFile(path, 'utf8');
    const persisted = finalizationSchema.parse(JSON.parse(raw));
    if (JSON.stringify(persisted) === JSON.stringify(state.finalization)) return false;

    /**
     * Delivery writes the immutable artifact before the ledger. If the process stops between
     * those two atomic replacements, accept only the single monotonic `deliveredAt` transition
     * and let state storage persist the recovered ledger before continuing.
     */
    const pendingReceipt = { ...persisted, deliveredAt: null };
    if (
        state.finalization.deliveredAt === null &&
        persisted.deliveredAt !== null &&
        JSON.stringify(pendingReceipt) === JSON.stringify(state.finalization)
    ) {
        state.finalization = persisted;
        return true;
    }
    throw new Error('Persisted finalization receipt does not match the ledger');
}
