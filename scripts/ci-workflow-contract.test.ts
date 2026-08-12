import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

describe('CI workflow contract', () => {
    it('evaluates retry trailers on the pushed PR head instead of the synthetic merge commit', () => {
        const retryPolicyJob = workflow.match(/\n {2}retry-policy:\n([\s\S]*?)\n {2}checks:/u)?.[1];

        expect(retryPolicyJob).toContain('fetch-depth: 0');
        expect(retryPolicyJob).toContain("github.event_name == 'pull_request'");
        expect(retryPolicyJob).toContain("format('retry-policy / pr-{0} / base-{1}'");
        expect(retryPolicyJob).toContain("format('retry-policy / {0}', github.ref_name)");
        expect(retryPolicyJob).not.toContain('pr-${{ github.event.pull_request.number || 0 }}');
        expect(retryPolicyJob).toContain(
            'ref: ${{ github.event.pull_request.head.sha || github.sha }}',
        );
    });

    it('keeps one explicit npm cache owner and measures install phases separately', () => {
        expect(workflow.match(/package-manager-cache: false/gu)).toHaveLength(2);
        expect(workflow.match(/path: ~\/\.npm/gu)).toHaveLength(2);
        expect(workflow).toContain('npm ci --ignore-scripts --prefer-offline --no-audit --no-fund');
        expect(workflow).toContain('bun run rebuild');
        expect(
            workflow.match(
                /needs\.retry-policy\.outputs\.checks_scope == 'full' \|\| needs\.retry-policy\.outputs\.checks_scope == 'focused-source'/gu,
            ),
        ).toHaveLength(2);
    });

    it('supports fail-closed focused checks and hosted control or optimized E2E profiles', () => {
        expect(workflow).toContain(
            'types: [opened, synchronize, reopened, converted_to_draft, ready_for_review]',
        );
        expect(workflow).toContain("needs.retry-policy.outputs.checks_scope == 'full'");
        expect(workflow).toContain('focused-skills');
        expect(workflow).toContain('run: bun run scripts/run-ci-focused-checks.ts');
        expect(workflow).toContain("needs.retry-policy.outputs.run_e2e == 'true'");
        const interruptionIndex = workflow.indexOf('Desktop worker interruption recovery');
        const optimizedPoolIndex = workflow.indexOf('bun run scripts/run-e2e-pools.ts');

        expect(interruptionIndex).toBeGreaterThan(0);
        expect(optimizedPoolIndex).toBeGreaterThan(interruptionIndex);
        expect(workflow).toContain('bun run scripts/run-e2e-failure-isolation.ts');
        expect(workflow).toContain('bun run scripts/run-e2e-pools.ts');
        expect(workflow).toContain('bunx playwright test --workers=1');
        expect(workflow).toContain("if: github.event_name == 'workflow_dispatch'");
        expect(workflow).toContain('bun run scripts/run-hosted-parity.ts');
    });

    it('runs focused repair specs before the complete E2E suite and exposes one stable gate', () => {
        const e2eJob = workflow.match(/\n {2}e2e:\n([\s\S]*?)\n {2}ci:/u)?.[1];
        const focusedIndex = workflow.indexOf('run: bun run scripts/run-e2e-repair.ts');
        const fullIndex = workflow.indexOf('bunx playwright test --workers=1');

        expect(focusedIndex).toBeGreaterThan(0);
        expect(fullIndex).toBeGreaterThan(focusedIndex);
        expect(e2eJob).toContain('ref: ${{ github.event.pull_request.head.sha || github.sha }}');
        expect(workflow).toContain('name: CI gate');
        expect(workflow).toContain('needs: [retry-policy, checks, e2e]');
    });
});
