import { performance } from 'node:perf_hooks';

import type { CausalCapsule, CausalCapsuleInput, StructuredLogger } from '@caxri/system';
import { BoundedCausalChain, logEventCatalog } from '@caxri/system';

import { createBestEffortTeardown } from '../domains/best-effort-teardown';

/**
 * The Server Core shutdown steps, a closed set so `server_core.stop_failed` names where a stop broke and
 * `server_core.stopped` attributes a slow stop. No name may read as a secret key (`credentials` would be redacted from
 * the record). `terminals` runs inside `domainServices` (see `DomainShutdownStepRunner`), so its time is also part of
 * that step's.
 */
export type ServerCoreStopStep =
    | 'agentInbox'
    | 'controlServer'
    | 'domainServices'
    | 'extensionHost'
    | 'lease'
    | 'mobileAccess'
    | 'providerMessaging'
    | 'terminals';

const stopFailure: Omit<CausalCapsuleInput, 'context' | 'timestamp'> = {
    owner: 'server-core',
    phase: 'shutdown',
    reason: 'unknown',
    remediation: 'restart-core',
    retryable: false,
};

/**
 * The failure capsule the process manifest carries when a signal-driven stop rejected, so offline diagnostics read the
 * exit as a fault instead of a clean `stopped`.
 */
export function serverCoreStopFailureCapsule(): CausalCapsule {
    return new BoundedCausalChain().record(stopFailure);
}

function elapsedMs(since: number): number {
    return Math.round(performance.now() - since);
}

/**
 * Opens a stop: writes `server_core.stopping`, then times each step and owns the outcome record. A failing step writes
 * one `server_core.stop_failed` with its closed step name and the time since `stopping`, then rethrows unchanged, so
 * callers keep their failure behavior and need no second writer. A nested step's failure is logged once, by the
 * innermost step, which names it most precisely.
 */
export function createServerCoreStopSteps(
    logger: Pick<StructuredLogger, 'write'>,
    reason: string,
): {
    run: (step: ServerCoreStopStep, action: () => unknown) => Promise<void>;
    stopped: () => void;
} {
    logger.write('info', logEventCatalog.serverCore.stopping, { fields: { reason } });
    const startedAt = performance.now();
    const logged = new WeakSet<object>();
    const stepDurations: Partial<Record<`${ServerCoreStopStep}Ms`, number>> = {};
    return {
        async run(step, action) {
            const stepStartedAt = performance.now();
            try {
                await action();
            } catch (error) {
                const isLogged = typeof error === 'object' && error !== null && logged.has(error);
                if (!isLogged) {
                    if (typeof error === 'object' && error !== null) logged.add(error);
                    logger.write('error', logEventCatalog.serverCore.stopFailed, {
                        durationMs: elapsedMs(startedAt),
                        fields: {
                            reason,
                            step,
                            message: error instanceof Error ? error.message : String(error),
                        },
                        failure: stopFailure,
                    });
                }
                throw error;
            } finally {
                stepDurations[`${step}Ms`] = elapsedMs(stepStartedAt);
            }
        },
        stopped() {
            logger.write('info', logEventCatalog.serverCore.stopped, {
                durationMs: elapsedMs(startedAt),
                fields: { reason, ...stepDurations },
            });
        },
    };
}

/**
 * Runs the Core teardown best-effort: every stage is attempted even after an earlier one failed, so the Terminal
 * snapshot, the control socket, the Extension Host and the profile lease are always released. Each failing stage is
 * logged once by `run`; after the last stage the collected failure (an `AggregateError` for several) is rethrown, and
 * the `server_core.stopped` record is written only for a clean stop. `stages` is built lazily so a stage reads Core
 * state at the moment it runs.
 */
export async function runServerCoreStop(
    logger: Pick<StructuredLogger, 'flush' | 'write'>,
    reason: string,
    stages: (
        run: ReturnType<typeof createServerCoreStopSteps>['run'],
    ) => Array<[ServerCoreStopStep, () => unknown]>,
): Promise<void> {
    const steps = createServerCoreStopSteps(logger, reason);
    const teardown = createBestEffortTeardown();
    try {
        // Yields once so the caller's `stopPromise` is assigned before a synchronous domain-shutdown side effect (e.g. a
        // state.changed emit) can hit `deliver`'s `if (!stopPromise)` extension-refresh branch.
        await Promise.resolve();
        await teardown.attempt(
            ...stages(steps.run).map(
                ([step, action]) =>
                    () =>
                        steps.run(step, action),
            ),
        );
        if (teardown.failureCount() === 0) steps.stopped();
    } finally {
        // A settled stop has written its records, so a caller that removes the profile next (a test teardown)
        // does not race an async append into `logs/` (ENOTEMPTY). A process exit flushes synchronously anyway.
        await logger.flush();
    }
    teardown.rethrow();
}
