import type { TestInfo } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import { allowE2EErrors, runWithE2EErrorGate } from '../../e2e/support/error-gate';
import { readPublicE2EDiagnostics } from '../reporters/public-e2e-diagnostics';

function testInfo(): TestInfo {
    return { annotations: [], status: 'passed' } as unknown as TestInfo;
}

describe('public E2E error-gate diagnostics', () => {
    it('recognizes a failed Playwright body when fixture use resolves normally', async () => {
        const info = testInfo();
        await runWithE2EErrorGate(info, () => {
            info.status = 'failed';
            return Promise.resolve();
        });
        expect(
            readPublicE2EDiagnostics(info.annotations).gateFailures?.map((entry) => entry.phase),
        ).toEqual(['body-failed']);
    });
    it('keeps an original test-body rejection and records its fixed phase', async () => {
        const info = testInfo();
        const original = new Error('synthetic private body failure');
        await expect(runWithE2EErrorGate(info, () => Promise.reject(original))).rejects.toBe(
            original,
        );
        expect(
            readPublicE2EDiagnostics(info.annotations).gateFailures?.map((entry) => entry.phase),
        ).toEqual(['body-failed']);
        expect(JSON.stringify(info.annotations)).not.toContain(original.message);
    });

    it('separates a completed body from the policy rejection of a missing allowance', async () => {
        const info = testInfo();
        let isCompleted = false;
        await expect(
            runWithE2EErrorGate(info, () => {
                allowE2EErrors([
                    { source: 'renderer', event: 'console', code: 'CONSOLE_ERROR', count: 1 },
                ]);
                isCompleted = true;
                return Promise.resolve();
            }),
        ).rejects.toThrow('Missing E2E errors');
        expect(isCompleted).toBe(true);
        const failures = readPublicE2EDiagnostics(info.annotations).gateFailures;
        expect(failures?.map((entry) => entry.phase)).toEqual([
            'policy-rejected',
            'finalize-failed',
        ]);
        expect(failures?.[0]?.actual.total).toBe(0);
        expect(failures?.[0]?.expected.groups).toEqual([
            { source: 'renderer', event: 'console', code: 'CONSOLE_ERROR', count: 1 },
        ]);
    });

    it('does not mark a successful body and error gate as failures', async () => {
        const info = testInfo();
        await runWithE2EErrorGate(info, () => Promise.resolve());
        expect(readPublicE2EDiagnostics(info.annotations)).toEqual({});
    });
});
