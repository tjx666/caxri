import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

import {
    acquireDesktopLease,
    releaseDesktopLease,
} from '../.agents/skills/switch-worktree/scripts/desktop-lease';
import { waitForChildExit } from './exec';

type E2EPool = 'control' | 'desktop-exclusive' | 'parallel-safe';

const e2eRunnerOwnerPattern = /^caxri-\d+-\d+-e2e$/u;

export function parseSpecPaths(raw: string | undefined): string[] {
    const value: unknown = JSON.parse(raw ?? 'null');
    const paths: unknown[] = Array.isArray(value) ? value : [];
    if (
        paths.length === 0 ||
        paths.some(
            (path) => typeof path !== 'string' || !/^e2e\/[a-z0-9][a-z0-9-]*\.e2e\.ts$/u.test(path),
        )
    ) {
        throw new Error('CI_E2E_TESTS must contain validated E2E spec paths');
    }
    return [...new Set(paths as string[])];
}

export function parseE2EPool(raw: string | undefined): E2EPool | 'control' {
    if ([undefined, '', 'control'].includes(raw)) return 'control';
    const exclusivePools = ['desktop-exclusive', 'parallel-safe'] as const;
    // `Array#includes` narrows its argument to the tuple's element type; widen the array's type
    // for the check instead of casting `raw` (which may legitimately be `undefined`) to `E2EPool`.
    if (raw !== undefined && (exclusivePools as readonly string[]).includes(raw))
        return raw as (typeof exclusivePools)[number];
    throw new Error('CI_E2E_POOL must be control, desktop-exclusive, or parallel-safe');
}

/**
 * Reuses the self-hosted run's short temporary root so its fail-safe cleanup also owns repair artifacts. Local runs
 * have no runner owner and create a separate short directory below instead.
 */
export function resolveOwnedRunnerTemporaryDirectory(
    environment: NodeJS.ProcessEnv,
): string | undefined {
    const owner = environment.CAXRI_RUNNER_OWNER;
    if (!owner) return undefined;
    const directory = environment.TMPDIR;
    if (!directory || !e2eRunnerOwnerPattern.test(owner)) {
        throw new Error('Focused E2E repair requires its runner-owned TMPDIR');
    }
    const expected = join('/private/tmp', owner);
    if (resolve(directory) !== expected) {
        throw new Error('Focused E2E repair requires its runner-owned TMPDIR');
    }
    return expected;
}

/**
 * Keeps the serial determinism pass under the same machine-global resource policy as the failed hosted pool. One
 * Playwright worker is still parallel-safe: its `TEST_PARALLEL_INDEX=0` namespace uses the shared coordinator, while
 * clipboard protection stays disabled exactly as it is in the later two-worker pressure pass.
 */
export function createParallelSafeRepairEnvironment(
    environment: NodeJS.ProcessEnv,
    coordinatorToken: string,
    outputDirectory: string,
    temporaryDirectory: string,
): NodeJS.ProcessEnv {
    const focusedEnvironment: NodeJS.ProcessEnv = {
        ...environment,
        CAXRI_E2E_COORDINATOR_TOKEN: coordinatorToken,
        CAXRI_E2E_OUTPUT_DIR: outputDirectory,
        CAXRI_E2E_POOL: 'parallel-safe',
        TEMP: temporaryDirectory,
        TMP: temporaryDirectory,
        TMPDIR: temporaryDirectory,
    };
    delete focusedEnvironment.CAXRI_DESKTOP_COORDINATOR_TOKEN;
    return focusedEnvironment;
}

async function runFocused(
    paths: readonly string[],
    workers: number,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
    const child = spawn(
        'bunx',
        [
            'playwright',
            'test',
            ...paths,
            `--workers=${workers}`,
            '--repeat-each=3',
            '--reporter=line',
        ],
        { env: environment, stdio: 'inherit' },
    );
    return waitForChildExit(child, { event: 'close', nullExitCode: 1 });
}

async function main(): Promise<void> {
    const paths = parseSpecPaths(process.env.CI_E2E_TESTS);
    const pool = parseE2EPool(process.env.CI_E2E_POOL);
    await Promise.all(paths.map((path) => access(path)));
    let code: number;
    if (pool === 'parallel-safe') {
        /**
         * The worker fixture adds its namespace beneath TMPDIR. Keep the parent short because macOS limits Unix socket
         * paths to 104 bytes and both Agent hooks and Chromium create sockets below the resulting worker directory.
         */
        const runnerTemporaryDirectory = resolveOwnedRunnerTemporaryDirectory(process.env);
        const temporaryDirectory = runnerTemporaryDirectory ?? (await mkdtemp('/private/tmp/cxr-'));
        try {
            /**
             * Hold one coordinator across both phases so sibling worktrees cannot enter between repetitions. The serial
             * pass proves deterministic behavior before the second pass recreates namespaced two-worker pressure.
             */
            const coordinator = await acquireDesktopLease(
                process.cwd(),
                'Focused parallel-safe E2E repair',
            );
            try {
                code = await runFocused(
                    paths,
                    1,
                    createParallelSafeRepairEnvironment(
                        process.env,
                        coordinator.token,
                        'test-results/e2e-repair-serial',
                        temporaryDirectory,
                    ),
                );
                if (code === 0) {
                    code = await runFocused(
                        paths,
                        2,
                        createParallelSafeRepairEnvironment(
                            process.env,
                            coordinator.token,
                            'test-results/e2e-repair-parallel-safe',
                            temporaryDirectory,
                        ),
                    );
                }
            } finally {
                await releaseDesktopLease(coordinator);
            }
        } finally {
            if (!runnerTemporaryDirectory) {
                await rm(temporaryDirectory, { force: true, recursive: true });
            }
        }
    } else code = await runFocused(paths, 1);
    if (code !== 0) process.exitCode = code;
}

if (import.meta.main) await main();
