import { join } from 'node:path';

export interface E2EWorkerIsolation {
    coordinatorToken?: string;
    leaseNamespace?: string;
    workerNamespace?: string;
}

export function e2eWorkerTemporaryDirectory(
    parent: string,
    isolation: E2EWorkerIsolation,
): string | undefined {
    return isolation.workerNamespace
        ? join(parent, `caxri-e2e-${isolation.workerNamespace}`)
        : undefined;
}

/** Derives worker-scoped native ownership only for the explicitly classified parallel pool. */
export function resolveE2EWorkerIsolation(environment: NodeJS.ProcessEnv): E2EWorkerIsolation {
    if (environment.CAXRI_E2E_POOL !== 'parallel-safe') return {};
    const parallelIndex = environment.TEST_PARALLEL_INDEX;
    const coordinatorToken = environment.CAXRI_E2E_COORDINATOR_TOKEN;
    if (!parallelIndex || !/^\d+$/u.test(parallelIndex)) {
        throw new Error('parallel-safe E2E requires a numeric TEST_PARALLEL_INDEX');
    }
    if (!coordinatorToken || !/^[0-9a-f-]{36}$/u.test(coordinatorToken)) {
        throw new Error('parallel-safe E2E requires its desktop coordinator token');
    }
    return {
        coordinatorToken,
        leaseNamespace: `e2e-worker-${parallelIndex}`,
        workerNamespace: `parallel-safe-${parallelIndex}`,
    };
}
