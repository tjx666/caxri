import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { ConcurrentValidationProcesses, isVerificationPassed } from '../ci-concurrent-validation';

const greenReceipt = {
    checks: 0,
    ciParity: 0,
    desktopExclusive: 0,
    e2eSetup: 0,
    failureCensus: 0,
    failureIsolation: 0,
    manifest: 0,
    parallelSafe: 0,
    provenance: {
        checksRevision: 'b'.repeat(40),
        exactHead: 'a'.repeat(40),
        parallelWorkers: 3,
        profile: 'optimized' as const,
        runAttempt: '1',
        runId: '123',
    },
    version: 1 as const,
};

/**
 * Split out of `ci-concurrent-validation.test.ts` (source-size ratchet, see `scripts/source-size-ratchet.ts`) rather
 * than growing that file past its 600-line threshold.
 *
 * Regression guard for issue #1446: a full-checks failure `SIGTERM`s the sibling E2E pool component (`abortOnFailure:
 * false` only protects the pool from aborting _others_, not from being aborted itself), and the workflow's `verify
 * desktop-exclusive` step — and therefore its failure-artifact upload — depends on that component reading non-zero in
 * the concurrent-validation receipt no matter how the killed child actually exits. `scripts/run-e2e-pools.ts` now
 * survives the signal long enough to write a partial receipt and exit through its own `process.exitCode = 1` instead of
 * dying to the raw signal; this pins that either shape still fails closed here.
 */
describe('concurrent CI validation abort signal', () => {
    it('keeps desktop-exclusive verification closed when a checks failure SIGTERMs the sibling pool', async () => {
        // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess exposes Node EventEmitter events.
        const checksChild = new EventEmitter() as ChildProcess;
        Object.defineProperty(checksChild, 'pid', { value: 5241 });
        // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess exposes Node EventEmitter events.
        const poolChild = new EventEmitter() as ChildProcess;
        Object.defineProperty(poolChild, 'pid', { value: 5242 });
        const children = [checksChild, poolChild];
        const forceTimers: Array<() => void> = [];
        const runner = new ConcurrentValidationProcesses({
            clearForceTimer: () => {},
            setForceTimer: (callback) => {
                const timer = setTimeout(callback, 60_000);
                forceTimers.push(() => {
                    clearTimeout(timer);
                    callback();
                });
                return timer;
            },
            signalProcessGroup: () => {},
            spawnProcess: () => children.shift() as ChildProcess,
        });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            const checks = runner.run('checks-fixture', [], { stdio: 'ignore' });
            const desktopExclusive = runner.run(
                'desktop-exclusive-fixture',
                [],
                { stdio: 'ignore' },
                { abortOnFailure: false },
            );
            checksChild.emit('exit', 1, null);

            await expect(checks).resolves.toBe(1);
            // `run-e2e-pools.ts`'s own SIGTERM handler lets it finish its partial receipt and exit with code 1 on its
            // own terms, well inside the 2s force-kill window — simulated here without ever firing that timer.
            poolChild.emit('exit', 1, null);

            const receipt = {
                ...greenReceipt,
                // `run()` types its resolved value `number | null` for the (unreachable here) case where the
                // process group is already marked aborted before it ever spawns; both awaited values are asserted
                // non-null above, so `?? 0` only narrows the type back to `ConcurrentValidationReceipt`'s `number`.
                checks: (await checks) ?? 0,
                desktopExclusive: (await desktopExclusive) ?? 0,
            };
            expect(receipt.desktopExclusive).toBe(1);
            expect(isVerificationPassed(receipt, 'desktop-exclusive', receipt.provenance)).toBe(
                false,
            );
        } finally {
            error.mockRestore();
            for (const timer of forceTimers) timer();
        }
    });
});
