import { describe, expect, it } from 'vitest';

import { summarizeE2EReceipts } from './report-e2e-manifest';
import type { E2EPoolReceipt } from './reporters/e2e-receipt-reporter';

function receipt(pool: string, id: string, status: 'failed' | 'passed' = 'passed'): E2EPoolReceipt {
    return {
        failed: status === 'failed' ? 1 : 0,
        finished: 1,
        finishedAt: '2026-01-01T00:00:01.000Z',
        hash: 'unused',
        passed: status === 'passed' ? 1 : 0,
        planned: 1,
        pool,
        skipped: 0,
        started: 1,
        startedAt: '2026-01-01T00:00:00.000Z',
        status,
        tests: [{ id, location: `e2e/${id}.e2e.ts:1:1`, title: id }],
    };
}

describe('E2E execution receipt summary', () => {
    it('publishes a stable actual-run union without a separate Playwright collection', () => {
        const first = summarizeE2EReceipts([
            receipt('parallel-safe', 'safe'),
            receipt('desktop-exclusive', 'exclusive'),
        ]);

        expect(first).toMatchObject({
            failed: 0,
            finished: 2,
            passed: 2,
            planned: 2,
            pools: ['desktop-exclusive', 'parallel-safe'],
            skipped: 0,
            started: 2,
            status: 'passed',
        });
        expect(first.hash).toMatch(/^[0-9a-f]{64}$/u);
        expect(
            summarizeE2EReceipts([
                receipt('desktop-exclusive', 'exclusive'),
                receipt('parallel-safe', 'safe'),
            ]),
        ).toEqual(first);
    });

    it('fails closed on duplicate pools, overlapping tests, or mismatched planned counts', () => {
        expect(() =>
            summarizeE2EReceipts([receipt('control', 'one'), receipt('control', 'two')]),
        ).toThrow('pools must be unique');
        expect(() =>
            summarizeE2EReceipts([receipt('one', 'same'), receipt('two', 'same')]),
        ).toThrow('overlap');
        expect(() => summarizeE2EReceipts([{ ...receipt('control', 'one'), planned: 2 }])).toThrow(
            'does not match',
        );
        expect(() => summarizeE2EReceipts([{ ...receipt('control', 'one'), finished: 0 }])).toThrow(
            'outcomes do not match',
        );
    });
});
