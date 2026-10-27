import { describe, expect, it } from 'vitest';

import type { GreenReusePolicyInput } from '../ci-green-reuse';
import { evaluateGreenReusePolicy, isReusableGreenDeltaPath } from '../ci-green-reuse';

const headSha = 'b'.repeat(40);
const candidateHeadSha = 'a'.repeat(40);
const eligible: GreenReusePolicyInput = {
    candidate: {
        baseSha: 'c'.repeat(40),
        checksConclusion: 'success',
        e2eConclusion: 'success',
        event: 'pull_request',
        fullChecksConclusion: 'success',
        gateConclusion: 'success',
        headSha: candidateHeadSha,
        id: 123,
        pullRequestNumber: 17,
        repository: 'tjx666/caxri',
        runConclusion: 'success',
        workflowPath: '.github/workflows/ci.yml',
    },
    changedFiles: [
        '.agents/skills/acceptance/scripts/report.ts',
        '.agents/skills/acceptance/SKILL.md',
        'docs/testing.md',
    ],
    currentHeadSha: headSha,
    eventName: 'pull_request',
    isAncestor: true,
    pullRequestBaseSha: 'c'.repeat(40),
    pullRequestNumber: 17,
    repository: 'tjx666/caxri',
    workflowPath: '.github/workflows/ci.yml',
};

describe('CI ancestor green reuse', () => {
    it('reuses a same-PR ancestor only for Acceptance and documentation deltas', () => {
        expect(evaluateGreenReusePolicy(eligible)).toEqual({
            eligible: true,
            reason: 'ancestor run 123 fully validated the unchanged product and E2E tree',
        });

        for (const path of [
            '.agents/skills/acceptance/SKILL.md',
            '.agents/skills/acceptance/scripts/report.ts',
            '.claude/skills/acceptance/references/report.md',
            'README.md',
            'docs/testing.md',
        ]) {
            expect(isReusableGreenDeltaPath(path), path).toBe(true);
        }
    });

    it('rejects product, E2E, workflow, dependency, and unrelated skill deltas', () => {
        for (const path of [
            'apps/server/src/domains/index.ts',
            'e2e/support/helpers.ts',
            '.github/workflows/ci.yml',
            'pnpm-lock.yaml',
            '.agents/skills/e2e-testing/SKILL.md',
            '.agents/skills/switch-worktree/scripts/desktop-lease.ts',
        ]) {
            expect(isReusableGreenDeltaPath(path), path).toBe(false);
            expect(evaluateGreenReusePolicy({ ...eligible, changedFiles: [path] })).toMatchObject({
                eligible: false,
            });
        }
    });

    it('fails closed unless the prior run proves the exact PR lineage and all required jobs', () => {
        for (const input of [
            { ...eligible, eventName: 'push' },
            { ...eligible, isAncestor: false },
            { ...eligible, changedFiles: [] },
            { ...eligible, currentHeadSha: candidateHeadSha },
            { ...eligible, pullRequestBaseSha: 'd'.repeat(40) },
            { ...eligible, pullRequestNumber: 18 },
            { ...eligible, repository: 'other/repository' },
            { ...eligible, workflowPath: '.github/workflows/other.yml' },
            {
                ...eligible,
                candidate: { ...eligible.candidate, runConclusion: 'failure' },
            },
            {
                ...eligible,
                candidate: { ...eligible.candidate, checksConclusion: 'failure' },
            },
            {
                ...eligible,
                candidate: { ...eligible.candidate, fullChecksConclusion: 'skipped' },
            },
            {
                ...eligible,
                candidate: { ...eligible.candidate, e2eConclusion: 'skipped' },
            },
            {
                ...eligible,
                candidate: { ...eligible.candidate, gateConclusion: 'failure' },
            },
        ]) {
            expect(evaluateGreenReusePolicy(input).eligible).toBe(false);
        }
    });
});
