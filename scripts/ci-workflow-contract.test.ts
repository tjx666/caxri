import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

describe('CI workflow contract', () => {
    it('evaluates retry trailers on the pushed PR head instead of the synthetic merge commit', () => {
        const retryPolicyJob = workflow.match(/\n {2}retry-policy:\n([\s\S]*?)\n {2}checks:/u)?.[1];

        expect(retryPolicyJob).toContain('fetch-depth: 0');
        expect(retryPolicyJob).toContain(
            "name: retry-policy / pr-${{ github.event.pull_request.number || 0 }} / base-${{ github.event.pull_request.base.sha || '0000000000000000000000000000000000000000' }}",
        );
        expect(retryPolicyJob).toContain(
            'ref: ${{ github.event.pull_request.head.sha || github.sha }}',
        );
    });

    it('runs focused repair specs before the complete E2E suite and exposes one stable gate', () => {
        const focusedIndex = workflow.indexOf('run: bun run scripts/run-e2e-repair.ts');
        const fullIndex = workflow.indexOf('run: bunx playwright test');

        expect(focusedIndex).toBeGreaterThan(0);
        expect(fullIndex).toBeGreaterThan(focusedIndex);
        expect(workflow).toContain('name: CI gate');
        expect(workflow).toContain('needs: [retry-policy, checks, e2e]');
    });
});
