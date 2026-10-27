import { performance } from 'node:perf_hooks';

import type { CausalCapsule, CausalCapsuleInput, StructuredLogger } from '@caxri/system';
import { BoundedCausalChain, logEventCatalog } from '@caxri/system';

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
