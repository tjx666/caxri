import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { writeTextAtomic } from '../../../../scripts/atomic-json';
import type { IssueExpectationDrift } from './issue-drift';
import { assertIssueExpectationDriftReady } from './issue-drift';

const REQUIRED_HANDOFF_SECTIONS = [
    'delivery',
    'review',
    'technical-debt',
    'workflow',
    'cost',
    'automation',
    'boundaries',
] as const;

const handoffEvidenceSchema = z.object({
    actionsUse: z.string().min(1),
    commitFileMetrics: z.enum(['recorded', 'unavailable']),
    costCheckpointCount: z.number().int().positive(),
    reviewBaselineId: z.string().min(1),
    reviewDecisionCount: z.number().int().positive(),
    reviewLineageComplete: z.literal(true),
    reviewPolicyMode: z.enum(['full-once', 'quick', 'light']),
    issueDriftAssessmentCount: z.number().int().nonnegative(),
    issueDriftCommentCount: z.number().int().nonnegative(),
    validationRepairCount: z.number().int().nonnegative(),
});

export const handoffReportSchema = z.object({
    deliveredAt: z.string().nullable(),
    evidence: handoffEvidenceSchema,
    generatedAt: z.string(),
    headSha: z.string().min(1),
    path: z.literal('handoff-report.md'),
    sections: z
        .array(z.enum(REQUIRED_HANDOFF_SECTIONS))
        .length(REQUIRED_HANDOFF_SECTIONS.length)
        .refine(
            (sections) => REQUIRED_HANDOFF_SECTIONS.every((section) => sections.includes(section)),
            'Handoff report must contain every required section exactly once',
        ),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

export type HandoffReportReceipt = z.infer<typeof handoffReportSchema>;

interface ReviewDecision {
    baselineHeadSha: string | null;
    baselineReviewId: string | null;
    headSha: string;
    id: string;
    legacyMode?: string | null;
    mode: string;
    parentReviewId: string | null;
    productP0: number;
    productP1: number;
    reviewedRange: string;
}

interface ReportContext {
    acceptance: { status: string; url: string | null; waiverReason?: string | null };
    ciFallback: { status: string };
    handoffReport: HandoffReportReceipt | null;
    issues: Array<{
        commits: string[];
        expectationDrift: IssueExpectationDrift;
        number: number;
        status: string;
        title: string;
    }>;
    notes: {
        technical_debt: Array<{ text: string }>;
        token_waste: Array<{ text: string }>;
        workflow: Array<{ text: string }>;
    };
    objective: string;
    phase: string;
    pullRequest: {
        headSha: string | null;
        number: number | null;
        status: string;
        url: string | null;
    };
    reviewGate: {
        baselineReviewId: string | null;
        frozenHeadSha: string | null;
        rounds: ReviewDecision[];
    };
    reviewPolicy: { mode: 'full-once' | 'quick' | 'light'; source: string };
    retention: {
        archive: {
            byteLength: number;
            counts: Record<string, number>;
            entryCount: number;
            path: string;
            sha256: string;
        } | null;
    };
    runBudget: {
        checkpoints: Array<{
            boundary: 'batch' | 'issue' | 'manual' | 'phase';
            commitCount: number | 'unavailable';
            elapsedSeconds: number;
            fileCount: number | 'unavailable';
            fullReviewCount: number;
            issueNumber: number | null;
            phase: string;
            reviewFindingCount: number;
            tokenTelemetry: 'available' | 'degraded';
            tokens: number | 'unavailable';
            validationAttemptCount: number;
            validationRepairCount: number;
        }>;
        containment: {
            droppedWork: string[];
            reason: string;
            revisedEta: string;
        } | null;
        routedWork: Array<{ title: string }>;
    };
    validations: Array<{ id: string; kind: string; result: string }>;
}

function bullets(values: string[], empty: string): string {
    return values.length > 0 ? values.map((value) => `- ${value}`).join('\n') : `- ${empty}`;
}

function buildHandoffEvidence(state: ReportContext, headSha: string) {
    const baseline = state.reviewGate.rounds.find(
        ({ id }) => id === state.reviewGate.baselineReviewId,
    );
    if (!baseline) throw new Error('Handoff report requires an aggregate review baseline');
    const expectedBaselineMode =
        state.reviewPolicy.mode === 'full-once' ? 'full' : state.reviewPolicy.mode;
    const isLineageComplete = state.reviewGate.rounds.every((decision, index, rounds) => {
        if (index === 0) {
            return (
                decision.id === baseline.id &&
                decision.mode === expectedBaselineMode &&
                decision.baselineReviewId === null &&
                decision.baselineHeadSha === null &&
                decision.parentReviewId === null
            );
        }
        const parent = rounds[index - 1];
        return (
            decision.mode === 'light' &&
            decision.baselineReviewId === baseline.id &&
            decision.baselineHeadSha === baseline.headSha &&
            decision.parentReviewId === parent.id &&
            decision.reviewedRange === `${parent.headSha}..${decision.headSha}`
        );
    });
    if (!isLineageComplete) throw new Error('Handoff report requires complete review lineage');
    if (state.runBudget.checkpoints.length === 0) {
        throw new Error('Handoff report requires at least one cost checkpoint');
    }
    for (const issue of state.issues) {
        if (issue.status === 'deferred') continue;
        assertIssueExpectationDriftReady(issue, headSha);
    }
    const commitFileMetrics = state.runBudget.checkpoints.some(
        ({ commitCount, fileCount }) =>
            commitCount !== 'unavailable' && fileCount !== 'unavailable',
    )
        ? 'recorded'
        : 'unavailable';
    return handoffEvidenceSchema.parse({
        actionsUse: `remote=${state.pullRequest.status}; localFallback=${state.ciFallback.status}`,
        commitFileMetrics,
        costCheckpointCount: state.runBudget.checkpoints.length,
        issueDriftAssessmentCount: state.issues.filter(
            ({ expectationDrift }) => expectationDrift.assessedAt !== null,
        ).length,
        issueDriftCommentCount: state.issues.reduce(
            (count, { expectationDrift }) =>
                count +
                expectationDrift.records.filter(({ commentUrl }) => commentUrl !== null).length,
            0,
        ),
        reviewBaselineId: baseline.id,
        reviewDecisionCount: state.reviewGate.rounds.length,
        reviewLineageComplete: true,
        reviewPolicyMode: state.reviewPolicy.mode,
        validationRepairCount: state.validations.filter(({ result }) => result === 'failed').length,
    });
}

function buildHandoffReport(state: ReportContext, headSha: string): string {
    const evidence = buildHandoffEvidence(state, headSha);
    const issueLines = state.issues.map(({ commits, expectationDrift, number, title }) => {
        const comments = expectationDrift.records
            .flatMap(({ commentUrl }) => (commentUrl ? [commentUrl] : []))
            .join(', ');
        return `#${number} ${title} (${commits.join(', ') || 'no commit'}); drift=${expectationDrift.status}${comments ? `; comments=${comments}` : ''}`;
    });
    const reviewLines = state.reviewGate.rounds.map(
        ({ id, legacyMode, mode, parentReviewId, productP0, productP1, reviewedRange }) =>
            `${id}: ${mode}${legacyMode ? ` (imported legacy ${legacyMode})` : ''}, range=${reviewedRange}, parent=${parentReviewId ?? 'baseline'}, product P0=${productP0}, product P1=${productP1}`,
    );
    const costLines = state.runBudget.checkpoints.map(
        ({
            boundary,
            commitCount,
            elapsedSeconds,
            fileCount,
            fullReviewCount,
            issueNumber,
            phase,
            reviewFindingCount,
            tokenTelemetry,
            tokens,
            validationAttemptCount,
            validationRepairCount,
        }) =>
            `${phase}/${boundary}${issueNumber ? `/#${issueNumber}` : ''}: tokens=${String(tokens)} (${tokenTelemetry}), elapsedSeconds=${String(elapsedSeconds)}, commits=${String(commitCount)}, files=${String(fileCount)}, fullReviews=${fullReviewCount}, reviewFindings=${reviewFindingCount}, validationAttempts=${validationAttemptCount}, validationRepairs=${validationRepairCount}`,
    );
    const automation = [
        ...state.notes.token_waste.map(({ text }) => text),
        ...state.runBudget.routedWork.map(({ title }) => `Follow-up: ${title}`),
    ];
    return `# Go 交付报告

- Objective: ${state.objective}
- Exact head: \`${headSha}\`
- PR: ${state.pullRequest.url ?? state.pullRequest.number ?? 'not created'}
- Acceptance: ${state.acceptance.url ?? state.acceptance.waiverReason ?? state.acceptance.status}

## 交付结果 <!-- section:delivery -->

${bullets(issueLines, '没有登记 issue。')}

## Review <!-- section:review -->

Policy: ${state.reviewPolicy.mode} (${state.reviewPolicy.source}); baseline=${evidence.reviewBaselineId}; lineageComplete=${String(evidence.reviewLineageComplete)}

${bullets(reviewLines, '没有登记 review。')}

## 技术债 <!-- section:technical-debt -->

${bullets(
    state.notes.technical_debt.map(({ text }) => text),
    '没有遗留技术债。',
)}

## Workflow 改进 <!-- section:workflow -->

${bullets(
    state.notes.workflow.map(({ text }) => text),
    '没有新增 workflow 观察。',
)}

## Token 与 Actions 成本 <!-- section:cost -->

${bullets(costLines, '运行环境没有提供成本数据。')}

Containment: ${state.runBudget.containment ? `${state.runBudget.containment.reason}; dropped=${state.runBudget.containment.droppedWork.join(',')}; revisedEta=${state.runBudget.containment.revisedEta}` : 'inactive'}

Actions: ${evidence.actionsUse}

History archive: ${state.retention.archive ? `${state.retention.archive.entryCount} entries/${state.retention.archive.byteLength} bytes; counts=${JSON.stringify(state.retention.archive.counts)}; sha256=${state.retention.archive.sha256}` : 'none'}

Validation: ${state.validations.map(({ id, kind, result }) => `${id}/${kind}/${result}`).join(', ') || 'none'}

## 自动化候选 <!-- section:automation -->

${bullets(automation, '没有新增自动化候选。')}

## 剩余边界 <!-- section:boundaries -->

${bullets(
    state.runBudget.routedWork.map(({ title }) => title),
    '没有被移出本次交付的事项。',
)}
`;
}

function validateHandoffSections(markdown: string): typeof REQUIRED_HANDOFF_SECTIONS {
    for (const section of REQUIRED_HANDOFF_SECTIONS) {
        if (!markdown.includes(`<!-- section:${section} -->`)) {
            throw new Error(`Handoff report is missing required section: ${section}`);
        }
    }
    return REQUIRED_HANDOFF_SECTIONS;
}

export async function generateHandoffReport(
    state: ReportContext,
    runDirectory: string,
    headSha: string,
    generatedAt = new Date().toISOString(),
): Promise<HandoffReportReceipt> {
    if (!['acceptance_handoff', 'finalization'].includes(state.phase)) {
        throw new Error('Handoff report can be generated only during handoff or finalization');
    }
    if (!state.pullRequest.headSha || state.pullRequest.headSha !== headSha) {
        throw new Error('Handoff report must bind the exact current PR head');
    }
    if (state.reviewGate.frozenHeadSha !== headSha) {
        throw new Error('Handoff report requires the exact review-frozen PR head');
    }
    if (state.validations.some(({ result }) => result === 'pending')) {
        throw new Error('Handoff report cannot be generated with pending validation');
    }
    const markdown = buildHandoffReport(state, headSha);
    const sections = validateHandoffSections(markdown);
    const evidence = buildHandoffEvidence(state, headSha);
    const path = join(runDirectory, 'handoff-report.md');
    await writeTextAtomic(path, markdown);
    state.handoffReport = handoffReportSchema.parse({
        deliveredAt: null,
        evidence,
        generatedAt,
        headSha,
        path: 'handoff-report.md',
        sections,
        sha256: createHash('sha256').update(markdown).digest('hex'),
    });
    return state.handoffReport;
}

export function recordHandoffDelivery(
    state: ReportContext,
    input: { acceptanceUrl?: string; headSha: string },
    deliveredAt = new Date().toISOString(),
): HandoffReportReceipt {
    if (!['acceptance_handoff', 'finalization'].includes(state.phase)) {
        throw new Error('Handoff report can be delivered only during handoff or finalization');
    }
    assertHandoffReady(state, input.headSha, false);
    if (state.acceptance.status !== 'waived' && input.acceptanceUrl !== state.acceptance.url) {
        throw new Error('Handoff delivery must include the stable Acceptance URL');
    }
    state.handoffReport!.deliveredAt = deliveredAt;
    return state.handoffReport!;
}

export function assertHandoffReady(
    state: ReportContext,
    headSha: string,
    shouldRequireDelivered = true,
): void {
    const report = state.handoffReport;
    if (!report) throw new Error('A generated handoff report is required');
    if (report.headSha !== headSha) throw new Error('Handoff report does not match the exact head');
    if (
        report.sections.length !== REQUIRED_HANDOFF_SECTIONS.length ||
        REQUIRED_HANDOFF_SECTIONS.some((section) => !report.sections.includes(section))
    ) {
        throw new Error('Handoff report is missing required sections');
    }
    handoffEvidenceSchema.parse(report.evidence);
    if (shouldRequireDelivered && !report.deliveredAt) {
        throw new Error('Handoff report has not been delivered to the user');
    }
}

export async function verifyHandoffReportArtifact(
    state: ReportContext,
    runDirectory: string,
): Promise<void> {
    if (!state.handoffReport) return;
    const path = join(runDirectory, state.handoffReport.path);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
        metadata = await lstat(path);
    } catch {
        throw new Error('Persisted handoff report is missing');
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error('Persisted handoff report must be a direct regular file');
    }
    const markdown = await readFile(path, 'utf8');
    validateHandoffSections(markdown);
    const sha256 = createHash('sha256').update(markdown).digest('hex');
    if (sha256 !== state.handoffReport.sha256) {
        throw new Error('Persisted handoff report checksum does not match the ledger');
    }
}
