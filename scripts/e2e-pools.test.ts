import { readdir } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createE2EPoolPlan, parallelSafeSpecs } from '../e2e/pools';
import { combinePoolReceipts, parseE2EPool } from './run-e2e-pools';

const allSpecs = [
    'e2e/editor-dotfiles.e2e.ts',
    'e2e/file-operations.e2e.ts',
    'e2e/process-explorer.e2e.ts',
    'e2e/screencast.e2e.ts',
];

describe('E2E pools', () => {
    it('requires one explicit logical pool per single-machine job step', () => {
        expect(parseE2EPool(['--pool', 'parallel-safe'])).toBe('parallel-safe');
        expect(parseE2EPool(['--pool', 'desktop-exclusive'])).toBe('desktop-exclusive');
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

    it('partitions the current repository manifest without duplicates or omissions', async () => {
        const repositorySpecs = (await readdir(new URL('../e2e', import.meta.url)))
            .filter((name) => name.endsWith('.e2e.ts'))
            .map((name) => `e2e/${name}`)
            .sort();
        const plan = createE2EPoolPlan(repositorySpecs);

        expect(plan.parallelSafe).toHaveLength(parallelSafeSpecs.length);
        expect(plan.desktopExclusive.length + plan.parallelSafe.length).toBe(
            repositorySpecs.length,
        );
        expect([...plan.desktopExclusive, ...plan.parallelSafe].sort()).toEqual(repositorySpecs);
        expect(parallelSafeSpecs).toContain('e2e/settings-parallel-safe.e2e.ts');
        expect(plan.desktopExclusive).toContain('e2e/settings.e2e.ts');
        expect(plan.parallelSafeInvocations).toEqual([{ specs: plan.parallelSafe }]);
        expect(plan.desktopExclusiveInvocations).toEqual([{ specs: plan.desktopExclusive }]);
    });

    it('combines receipt invocations without accepting duplicate tests', () => {
        const receipt = combinePoolReceipts('parallel-safe', [
            {
                failed: 0,
                finished: 1,
                finishedAt: '2026-01-01T00:00:01.000Z',
                hash: 'first',
                passed: 1,
                planned: 1,
                pool: 'parallel-safe',
                skipped: 0,
                started: 1,
                startedAt: '2026-01-01T00:00:00.000Z',
                status: 'passed',
                tests: [{ id: 'safe', location: 'e2e/safe.e2e.ts:1:1', title: 'safe' }],
            },
            {
                failed: 0,
                finished: 1,
                finishedAt: '2026-01-01T00:00:02.000Z',
                hash: 'second',
                passed: 1,
                planned: 1,
                pool: 'parallel-safe',
                skipped: 0,
                started: 1,
                startedAt: '2026-01-01T00:00:01.000Z',
                status: 'passed',
                tests: [
                    { id: 'settings-safe', location: 'e2e/settings.e2e.ts:1:1', title: 'safe' },
                ],
            },
        ]);

        expect(receipt).toMatchObject({
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
                receipt,
                {
                    ...receipt,
                    finished: 1,
                    passed: 1,
                    planned: 1,
                    started: 1,
                    tests: [receipt.tests[0]],
                },
            ]),
        ).toThrow('overlap');
    });
});
