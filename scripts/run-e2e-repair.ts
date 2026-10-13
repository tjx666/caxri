import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { relatedE2ESpecs } from '../.agents/skills/quality-check/scripts/source-imports';
import {
    acquireDesktopLease,
    releaseDesktopLease,
} from '../.agents/skills/switch-worktree/scripts/desktop-lease';
import { selectAffectedE2ETests } from './ci-path-policy';
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

/**
 * Repair runs repeat each spec three times to prove determinism; an affected pull-request run only needs one pass.
 */
export function parseE2ERepeat(raw: string | undefined): number {
    if (raw === undefined || raw === '') return 3;
    if (raw !== '1' && raw !== '3') throw new Error('CI_E2E_REPEAT must be 1 or 3');
    return Number(raw);
}

/**
 * Adds specs that import a changed source file. Runs here rather than in the policy job because resolving imports needs
 * the installed TypeScript compiler.
 */
async function withRelatedSpecs(
    paths: readonly string[],
    rawChangedFiles: string | undefined,
): Promise<string[]> {
    if (!rawChangedFiles) return [...paths];
    const value: unknown = JSON.parse(rawChangedFiles);
    if (!Array.isArray(value) || value.some((path) => typeof path !== 'string')) {
        throw new Error('CI_E2E_AFFECTED_FILES must be a JSON array of repository paths');
    }
    const changedFiles = value as string[];
    const related = await relatedE2ESpecs(
        process.cwd(),
        changedFiles.filter((path) => !path.startsWith('e2e/')),
    );
    const selected = selectAffectedE2ETests({
        changedFiles: [],
        declared: paths,
        existingSpecs: new Set([...paths, ...related]),
        related,
    });
    if (related.length > 0) console.log(`Affected E2E specs: ${selected.join(', ')}`);
    return selected;
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
 * Reuses an E2E job's validated short temporary root so its precise cleanup also owns repair artifacts. Local runs have
 * no runner owner and create a separate short directory below instead.
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
    repeat: number,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
    const child = spawn(
        'bunx',
        [
            'playwright',
            'test',
            ...paths,
            `--workers=${workers}`,
            `--repeat-each=${repeat}`,
            '--reporter=line',
        ],
        { env: environment, stdio: 'inherit' },
    );
    return waitForChildExit(child, { event: 'close', nullExitCode: 1 });
}

async function main(): Promise<void> {
    const paths = await withRelatedSpecs(
        parseSpecPaths(process.env.CI_E2E_TESTS),
        process.env.CI_E2E_AFFECTED_FILES,
    );
    const pool = parseE2EPool(process.env.CI_E2E_POOL);
    const repeat = parseE2ERepeat(process.env.CI_E2E_REPEAT);
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
                    repeat,
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
                        repeat,
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
    } else code = await runFocused(paths, 1, repeat);
    if (code !== 0) process.exitCode = code;
}

if (import.meta.main) await main();
