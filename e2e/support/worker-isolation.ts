import { rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface E2EWorkerIsolation {
    coordinatorToken?: string;
    leaseNamespace?: string;
    workerNamespace?: string;
}

export interface E2EClipboardPolicy {
    protectClipboard: boolean;
}

interface E2ETemporaryDirectoryCleanupDependencies {
    remove?: typeof rm;
    wait?: (delay: number) => Promise<void>;
}

function errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

export interface E2ELaunchCapabilities {
    clipboard: boolean;
    gpuMode: 'disabled' | 'enabled';
    windowMode: 'hidden' | 'visible';
}

/**
 * New specs land in the parallel-safe pool by default (`e2e/support/pools.ts`), so a launch that needs a desktop that
 * pool cannot give it must fail on its first run there instead of turning into an intermittent failure later. Workers
 * must never contend for the machine-global pasteboard, a visible window takes real OS focus from sibling workers, and
 * an enabled GPU contends for the one GPU; each belongs in `desktopExclusiveSpecs` with its reason. Desktop-exclusive,
 * control, and focused launches keep the clipboard snapshot/restore guarantee. `agentMode: { mode: 'real' }` is not
 * rejected: policy specs such as `agent-mode.e2e.ts` pair it with a synthetic executable inside their own fixtures.
 */
export function resolveE2ELaunchPolicy(
    environment: NodeJS.ProcessEnv,
    capabilities: E2ELaunchCapabilities,
): E2EClipboardPolicy {
    const clipboardProtection = environment.CAXRI_E2E_CLIPBOARD_PROTECTION;
    if (clipboardProtection !== undefined && clipboardProtection !== 'skip-hosted') {
        throw new Error('CAXRI_E2E_CLIPBOARD_PROTECTION must be skip-hosted when set');
    }
    const isParallelSafe = environment.CAXRI_E2E_POOL === 'parallel-safe';
    if (isParallelSafe) {
        if (capabilities.clipboard) throw new Error('E2E clipboard access is not parallel-safe');
        const rejected = [
            capabilities.windowMode === 'visible' && "windowMode: 'visible'",
            capabilities.gpuMode === 'enabled' && "gpuMode: 'enabled'",
        ].filter((entry): entry is string => typeof entry === 'string');
        if (rejected.length > 0) {
            throw new Error(
                `E2E launch with ${rejected.join(', ')} is not parallel-safe; list the spec in desktopExclusiveSpecs`,
            );
        }
    }
    if (clipboardProtection === 'skip-hosted') {
        if (environment.CI !== 'true' || environment.RUNNER_ENVIRONMENT !== 'github-hosted') {
            throw new Error(
                'skip-hosted clipboard protection requires a disposable GitHub-hosted CI runner',
            );
        }
        if (capabilities.clipboard) {
            throw new Error('A clipboard-capable E2E launch cannot skip clipboard protection');
        }
        return { protectClipboard: false };
    }
    if (!isParallelSafe) return { protectClipboard: true };
    return { protectClipboard: false };
}

export function e2eWorkerTemporaryDirectory(
    parent: string,
    isolation: E2EWorkerIsolation,
): string | undefined {
    return isolation.workerNamespace
        ? join(parent, `caxri-e2e-${isolation.workerNamespace}`)
        : undefined;
}

/**
 * Callers run this only after their launch finalizers have awaited Desktop and Server shutdown, but macOS can still
 * expose a last directory entry while Node's recursive traversal is finishing. Retry only that observed `ENOTEMPTY` on
 * the exact temporary root for a small bounded window; every other error and the final failed attempt propagate
 * unchanged.
 */
export async function removeE2ETemporaryDirectory(
    directory: string,
    dependencies: E2ETemporaryDirectoryCleanupDependencies = {},
): Promise<void> {
    const remove = dependencies.remove ?? rm;
    const wait =
        dependencies.wait ??
        ((delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay)));
    for (let attempt = 0; ; attempt += 1) {
        try {
            // eslint-disable-next-line no-await-in-loop -- each retry depends on the previous filesystem result
            await remove(directory, { force: true, recursive: true });
            return;
        } catch (error) {
            if (errorCode(error) !== 'ENOTEMPTY' || attempt >= 3) throw error;
            // eslint-disable-next-line no-await-in-loop -- bounded linear backoff between cleanup attempts
            await wait(100 * (attempt + 1));
        }
    }
}

/**
 * Derives worker-scoped native ownership only for the explicitly classified parallel pool.
 */
export function resolveE2EWorkerIsolation(environment: NodeJS.ProcessEnv): E2EWorkerIsolation {
    if (environment.CAXRI_E2E_POOL !== 'parallel-safe') {
        const coordinatorToken = environment.CAXRI_DESKTOP_COORDINATOR_TOKEN;
        if (!coordinatorToken) return {};
        if (!/^[0-9a-f-]{36}$/u.test(coordinatorToken)) {
            throw new Error('desktop command requires a valid coordinator token');
        }
        return {
            coordinatorToken,
            leaseNamespace: 'e2e-desktop-command',
        };
    }
    const parallelIndex = environment.TEST_PARALLEL_INDEX;
    if (!parallelIndex || !/^\d+$/u.test(parallelIndex)) {
        throw new Error('parallel-safe E2E requires a numeric TEST_PARALLEL_INDEX');
    }
    const coordinatorToken = environment.CAXRI_E2E_COORDINATOR_TOKEN;
    if (!coordinatorToken || !/^[0-9a-f-]{36}$/u.test(coordinatorToken)) {
        throw new Error('parallel-safe E2E requires its desktop coordinator token');
    }
    return {
        coordinatorToken,
        leaseNamespace: `e2e-worker-${parallelIndex}`,
        workerNamespace: `parallel-safe-${parallelIndex}`,
    };
}
