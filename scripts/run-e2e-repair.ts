import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import process from 'node:process';

import {
    acquireDesktopLease,
    releaseDesktopLease,
} from '../.agents/skills/switch-worktree/scripts/desktop-lease';

type E2EPool = 'control' | 'desktop-exclusive' | 'parallel-safe';

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
    return new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve(code ?? 1));
    });
}

async function main(): Promise<void> {
    const paths = parseSpecPaths(process.env.CI_E2E_TESTS);
    const pool = parseE2EPool(process.env.CI_E2E_POOL);
    await Promise.all(paths.map((path) => access(path)));
    let code = await runFocused(paths, 1);
    if (code === 0 && pool === 'parallel-safe') {
        /**
         * The serial repetitions prove deterministic behavior; this second focused phase recreates the failed hosted
         * pool's namespaced two-worker pressure.
         */
        const coordinator = await acquireDesktopLease(
            process.cwd(),
            'Focused parallel-safe E2E repair',
        );
        try {
            code = await runFocused(paths, 2, {
                ...process.env,
                CAXRI_E2E_COORDINATOR_TOKEN: coordinator.token,
                CAXRI_E2E_POOL: 'parallel-safe',
                CAXRI_E2E_OUTPUT_DIR: 'test-results/e2e-repair-parallel-safe',
            });
        } finally {
            await releaseDesktopLease(coordinator);
        }
    }
    if (code !== 0) process.exitCode = code;
}

if (import.meta.main) await main();
