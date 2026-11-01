import { describe, expect, it } from 'vitest';

import { hasFailedE2EJob } from '../watch-ci';
import { summarizeE2EFailures } from '../watch-ci-e2e-failures';

const publicLine = (event: Record<string, unknown>) =>
    `e2e-parallel (2)\tRun E2E\t2026-11-01T08:00:00.0000000Z CAXRI_E2E_PUBLIC ${JSON.stringify(event)}`;

describe('summarizeE2EFailures', () => {
    it('lists failed and timed-out cases from the public reporter in log order', () => {
        const log = [
            publicLine({ event: 'begin', planned: 3 }),
            publicLine({
                event: 'test-end',
                location: 'e2e/a.e2e.ts:10',
                status: 'passed',
                retry: 0,
            }),
            publicLine({
                event: 'test-end',
                failureClass: {
                    frames: ['e2e/b.e2e.ts:42'],
                    kind: 'assertion-timeout',
                    matcher: 'toHaveCount',
                },
                failureLocation: { column: 9, line: 42 },
                location: 'e2e/b.e2e.ts:30',
                retry: 1,
                status: 'failed',
            }),
            'unrelated output CAXRI_E2E_PUBLIC {not json',
            publicLine({ event: 'test-end', location: 'e2e/c.e2e.ts:5', status: 'timedOut' }),
        ].join('\n');

        expect(summarizeE2EFailures(log)).toEqual([
            'e2e/b.e2e.ts:42 · failed · assertion-timeout toHaveCount · retry 1',
            'e2e/c.e2e.ts:5 · timedOut · unclassified · retry 0',
        ]);
    });

    it('returns nothing for a log without public events', () => {
        expect(summarizeE2EFailures('lint: error in foo.ts')).toEqual([]);
    });
});

describe('hasFailedE2EJob', () => {
    it('matches only failed E2E jobs', () => {
        expect(
            hasFailedE2EJob([
                { conclusion: 'failure', name: 'unit (1/3)', status: 'completed' },
                { conclusion: 'success', name: 'e2e-parallel (1)', status: 'completed' },
            ]),
        ).toBe(false);
        expect(
            hasFailedE2EJob([
                { conclusion: 'failure', name: 'e2e-parallel (exclusive 2)', status: 'completed' },
            ]),
        ).toBe(true);
    });
});
