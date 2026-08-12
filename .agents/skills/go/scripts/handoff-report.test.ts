import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    generateFinalization,
    recordFinalizationDelivery,
    verifyFinalizationArtifact,
} from './finalization';
import {
    generateHandoffReport,
    recordHandoffDelivery,
    verifyHandoffReportArtifact,
} from './handoff-report';
import { recordReviewDecision } from './review-gate';
import { recordCostCheckpoint } from './run-budget';
import { createInitialState, upsertIssue } from './state';

function reportState(runId: string) {
    const state = createInitialState({ objective: 'Persist report', runId });
    state.phase = 'deep_review';
    state.status = 'active';
    recordReviewDecision(state, {
        freeze: true,
        headSha: 'head-1',
        mode: 'full',
        p0: 0,
        p1: 0,
        reviewedRange: 'origin/main...head-1',
        scope: 'Goal range',
    });
    state.phase = 'acceptance_handoff';
    recordCostCheckpoint(state, {
        commitCount: 2,
        elapsedSeconds: 120,
        fileCount: 8,
        tokens: 'unavailable',
    });
    state.pullRequest = {
        headSha: 'head-1',
        number: 120,
        status: 'ready',
        url: 'https://github.com/tjx666/caxri/pull/120',
    };
    return state;
}

describe('Go persisted handoff artifacts', () => {
    let directory: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'caxri-go-report-'));
    });

    afterEach(async () => {
        await rm(directory, { force: true, recursive: true });
    });

    it('generates a complete exact-head report and verifies its checksum', async () => {
        const state = reportState('report-test');
        state.acceptance = {
            ...state.acceptance,
            id: 'acc-1',
            round: 1,
            status: 'pending',
            url: 'https://app.lobehub.com/acceptance/acc-1',
        };
        const receipt = await generateHandoffReport(state, directory, 'head-1');
        const markdown = await readFile(join(directory, 'handoff-report.md'), 'utf8');

        expect(markdown).toContain('<!-- section:delivery -->');
        expect(markdown).toContain('<!-- section:boundaries -->');
        expect(markdown).toContain('commits=2, files=8, fullReviews=1');
        expect(markdown).toContain('Actions: hosted=ready; localFallback=not_requested');
        expect(markdown).toContain('baseline=review-001; lineageComplete=true');
        expect(receipt).toMatchObject({ deliveredAt: null, headSha: 'head-1' });
        expect(receipt.evidence).toMatchObject({
            commitFileMetrics: 'recorded',
            reviewBaselineId: 'review-001',
            reviewLineageComplete: true,
        });
        await expect(verifyHandoffReportArtifact(state, directory)).resolves.toBeUndefined();

        recordHandoffDelivery(state, {
            acceptanceUrl: 'https://app.lobehub.com/acceptance/acc-1',
            headSha: 'head-1',
        });
        expect(state.handoffReport?.deliveredAt).not.toBeNull();
    });

    it('fails closed when the persisted report is missing or changed', async () => {
        const state = reportState('report-tamper');
        await generateHandoffReport(state, directory, 'head-1');

        await writeFile(join(directory, 'handoff-report.md'), '# changed\n', 'utf8');
        await expect(verifyHandoffReportArtifact(state, directory)).rejects.toThrow(
            'missing required section',
        );
        await rm(join(directory, 'handoff-report.md'));
        await expect(verifyHandoffReportArtifact(state, directory)).rejects.toThrow(
            'Persisted handoff report is missing',
        );
    });

    it('does not follow a symlinked persisted report', async () => {
        const state = reportState('report-symlink');
        await generateHandoffReport(state, directory, 'head-1');
        const reportPath = join(directory, 'handoff-report.md');
        const otherPath = join(directory, 'other-report.md');
        await writeFile(otherPath, await readFile(reportPath));
        await rm(reportPath);
        await symlink(otherPath, reportPath);

        await expect(verifyHandoffReportArtifact(state, directory)).rejects.toThrow(
            'must be a direct regular file',
        );
    });

    it('rejects marker-only reports without structured review and cost evidence', async () => {
        const missingReview = reportState('report-missing-review');
        missingReview.reviewGate.baselineReviewId = null;
        await expect(generateHandoffReport(missingReview, directory, 'head-1')).rejects.toThrow(
            'aggregate review baseline',
        );

        const missingCost = reportState('report-missing-cost');
        missingCost.runBudget.checkpoints = [];
        await expect(generateHandoffReport(missingCost, directory, 'head-1')).rejects.toThrow(
            'at least one cost checkpoint',
        );
    });

    it('persists final remote evidence for every intended issue before completion', async () => {
        const state = createInitialState({
            objective: 'Finalize Goal',
            runId: 'finalization-test',
        });
        state.phase = 'finalization';
        state.status = 'active';
        upsertIssue(state, { number: 107, status: 'complete', title: 'CI retries' });
        upsertIssue(state, { number: 111, status: 'complete', title: 'Go state' });
        upsertIssue(state, { number: 103, status: 'deferred', title: 'Tart spike' });
        state.pullRequest = { headSha: 'head-1', number: 120, status: 'merged', url: null };
        state.acceptance = {
            ...state.acceptance,
            status: 'waived',
            waivedHeadSha: 'head-1',
            waiverReason: 'No product behavior changed.',
        };

        await generateFinalization(state, directory, {
            headSha: 'head-1',
            issues: [
                { number: 107, projectStatus: 'Done', state: 'CLOSED' },
                { number: 111, projectStatus: 'Done', state: 'CLOSED' },
            ],
            mergeSha: 'merge-1',
        });
        await recordFinalizationDelivery(state, directory, '2026-08-12T02:00:00.000Z');

        await expect(verifyFinalizationArtifact(state, directory)).resolves.toBeUndefined();
        expect(
            JSON.parse(await readFile(join(directory, 'finalization.json'), 'utf8')),
        ).toMatchObject({
            deliveredAt: '2026-08-12T02:00:00.000Z',
            mergeSha: 'merge-1',
        });
    });

    it('rejects partial final issue evidence', async () => {
        const state = createInitialState({ objective: 'Finalize Goal', runId: 'finalization-gap' });
        state.phase = 'finalization';
        state.status = 'active';
        upsertIssue(state, { number: 107, status: 'complete', title: 'CI retries' });
        upsertIssue(state, { number: 111, status: 'complete', title: 'Go state' });
        state.pullRequest = { headSha: 'head-1', number: 120, status: 'merged', url: null };
        state.acceptance = {
            ...state.acceptance,
            status: 'waived',
            waivedHeadSha: 'head-1',
            waiverReason: 'No product behavior changed.',
        };

        await expect(
            generateFinalization(state, directory, {
                headSha: 'head-1',
                issues: [{ number: 107, projectStatus: 'Done', state: 'CLOSED' }],
                mergeSha: 'merge-1',
            }),
        ).rejects.toThrow('must match every intended ledger issue');
    });

    it('does not follow a symlinked finalization receipt', async () => {
        const state = createInitialState({ objective: 'Finalize Goal', runId: 'final-symlink' });
        state.phase = 'finalization';
        state.status = 'active';
        upsertIssue(state, { number: 111, status: 'complete', title: 'Go state' });
        state.pullRequest = { headSha: 'head-1', number: 120, status: 'merged', url: null };
        state.acceptance = {
            ...state.acceptance,
            status: 'waived',
            waivedHeadSha: 'head-1',
            waiverReason: 'No product behavior changed.',
        };
        await generateFinalization(state, directory, {
            headSha: 'head-1',
            issues: [{ number: 111, projectStatus: 'Done', state: 'CLOSED' }],
            mergeSha: 'merge-1',
        });
        const receiptPath = join(directory, 'finalization.json');
        const otherPath = join(directory, 'other-finalization.json');
        await writeFile(otherPath, await readFile(receiptPath));
        await rm(receiptPath);
        await symlink(otherPath, receiptPath);

        await expect(verifyFinalizationArtifact(state, directory)).rejects.toThrow(
            'must be a direct regular file',
        );
    });
});
