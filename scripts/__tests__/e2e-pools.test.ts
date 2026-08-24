import { readdir } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
    clipboardCapabilitySpecs,
    createE2EPoolPlan,
    parallelSafeSpecs,
} from '../../e2e/support/pools';
import type { E2ETestReceipt } from '../reporters/e2e-receipt-reporter';
import { createE2EPoolReceipt, stableErrorIdentity } from '../reporters/e2e-receipt-reporter';
import { combinePoolReceipts, mergeCensusReceipts, parseE2EPool } from '../run-e2e-pools';

const allSpecs = [
    'e2e/editor-dotfiles.e2e.ts',
    'e2e/file-operations.e2e.ts',
    'e2e/process-explorer.e2e.ts',
    'e2e/screencast.e2e.ts',
];

function testReceipt(
    id: string,
    verdict: E2ETestReceipt['verdict'] = 'pass',
    errorIdentity: string | null = null,
): E2ETestReceipt {
    return {
        artifacts: verdict === 'fail' ? [`test-results/${id}/trace.zip`] : [],
        errorIdentity,
        id,
        location: `e2e/${id}.e2e.ts:1:1`,
        title: id,
        verdict,
    };
}

function receipt(pool: 'control' | 'desktop-exclusive' | 'parallel-safe', tests: E2ETestReceipt[]) {
    return createE2EPoolReceipt({
        finishedAt: '2026-01-01T00:00:01.000Z',
        pool,
        startedAt: '2026-01-01T00:00:00.000Z',
        tests,
    });
}

describe('E2E pools', () => {
    it('requires one explicit logical pool per single-machine job step', () => {
        expect(parseE2EPool(['--pool', 'parallel-safe'])).toBe('parallel-safe');
        expect(parseE2EPool(['--pool', 'desktop-exclusive'])).toBe('desktop-exclusive');
        expect(parseE2EPool(['--pool', 'control'])).toBe('control');
        expect(() => parseE2EPool([])).toThrow('Usage: run-e2e-pools.ts');
        expect(() => parseE2EPool(['--pool', 'unknown'])).toThrow('Usage: run-e2e-pools.ts');
    });

    it('keeps unclassified and machine-global specs desktop-exclusive', () => {
        const plan = createE2EPoolPlan(allSpecs, ['e2e/editor-dotfiles.e2e.ts']);

        expect(plan.parallelSafe).toEqual(['e2e/editor-dotfiles.e2e.ts']);
        expect(plan.desktopExclusive).toEqual([
            'e2e/file-operations.e2e.ts',
            'e2e/process-explorer.e2e.ts',
            'e2e/screencast.e2e.ts',
        ]);
        expect(new Set([...plan.parallelSafe, ...plan.desktopExclusive]).size).toBe(
            allSpecs.length,
        );
    });

    it('rejects duplicate or unknown parallel-safe classifications', () => {
        expect(() =>
            createE2EPoolPlan(allSpecs, [
                'e2e/editor-dotfiles.e2e.ts',
                'e2e/editor-dotfiles.e2e.ts',
            ]),
        ).toThrow('Duplicate parallel-safe E2E spec');
        expect(() => createE2EPoolPlan(allSpecs, ['e2e/missing.e2e.ts'])).toThrow(
            'Unknown parallel-safe E2E spec',
        );
    });

    it('never classifies known machine-global specs as parallel-safe', () => {
        for (const path of [
            'e2e/bug-report.e2e.ts',
            'e2e/failure-isolation.e2e.ts',
            'e2e/file-operations.e2e.ts',
            'e2e/process-explorer-recovery.e2e.ts',
            'e2e/process-explorer.e2e.ts',
            'e2e/real-agent-smoke.e2e.ts',
            'e2e/screencast.e2e.ts',
            'e2e/session-attention.e2e.ts',
            'e2e/terminal-selection.e2e.ts',
            'e2e/terminal-shortcuts.e2e.ts',
            'e2e/window-mode.e2e.ts',
        ]) {
            expect(parallelSafeSpecs, path).not.toContain(path);
        }
    });

    it('keeps every declared clipboard capability spec desktop-exclusive', () => {
        expect(new Set(clipboardCapabilitySpecs).size).toBe(clipboardCapabilitySpecs.length);
        for (const path of clipboardCapabilitySpecs) {
            expect(parallelSafeSpecs, path).not.toContain(path);
        }
    });

    it('partitions the current repository manifest without duplicates or omissions', async () => {
        const repoSpecs = (await readdir(new URL('../../e2e', import.meta.url)))
            .filter((name) => name.endsWith('.e2e.ts'))
            .map((name) => `e2e/${name}`)
            .toSorted((left, right) => left.localeCompare(right));
        const plan = createE2EPoolPlan(repoSpecs);

        expect(plan.parallelSafe).toHaveLength(parallelSafeSpecs.length);
        expect(plan.desktopExclusive.length + plan.parallelSafe.length).toBe(repoSpecs.length);
        expect(
            [...plan.desktopExclusive, ...plan.parallelSafe].toSorted((left, right) =>
                left.localeCompare(right),
            ),
        ).toEqual(repoSpecs);
        expect(parallelSafeSpecs).toContain('e2e/settings-parallel-safe.e2e.ts');
        expect(plan.desktopExclusive).toContain('e2e/settings.e2e.ts');
        expect(plan.parallelSafeInvocations).toEqual([{ specs: plan.parallelSafe }]);
        expect(plan.desktopExclusiveInvocations).toEqual([{ specs: plan.desktopExclusive }]);
    });

    it('combines receipt invocations without accepting duplicate tests', () => {
        const combinedReceipt = combinePoolReceipts('parallel-safe', [
            receipt('parallel-safe', [testReceipt('safe')]),
            receipt('parallel-safe', [testReceipt('settings-safe')]),
        ]);

        expect(combinedReceipt).toMatchObject({
            failed: 0,
            finished: 2,
            passed: 2,
            planned: 2,
            skipped: 0,
            started: 2,
            status: 'passed',
        });
        expect(() =>
            combinePoolReceipts('parallel-safe', [
                combinedReceipt,
                createE2EPoolReceipt({
                    finishedAt: combinedReceipt.finishedAt,
                    pool: 'parallel-safe',
                    startedAt: combinedReceipt.startedAt,
                    tests: [combinedReceipt.tests[0]],
                }),
            ]),
        ).toThrow('overlap');
    });

    it('fills suppressed verdicts and groups the same failure identity without losing artifacts', () => {
        const identity = stableErrorIdentity('Expected ready state at /private/tmp/run-a:42:7');
        expect(identity).toBe(
            stableErrorIdentity('Expected ready state at /private/tmp/run-b:99:3'),
        );
        const initial = receipt('parallel-safe', [
            testReceipt('first', 'fail', identity),
            testReceipt('second', 'unknown'),
            testReceipt('third', 'unknown'),
        ]);
        const combined = mergeCensusReceipts(initial, [
            receipt('parallel-safe', [testReceipt('second', 'fail', identity)]),
            receipt('parallel-safe', [testReceipt('third', 'timeout', identity)]),
        ]);

        expect(combined).toMatchObject({
            failureGroups: [{ count: 3, identity }],
            unknown: 0,
        });
        expect(combined.specs.every(({ verdict }) => verdict !== 'unknown')).toBe(true);
        expect(combined.tests[1].artifacts).toEqual(['test-results/second/trace.zip']);
    });
});
