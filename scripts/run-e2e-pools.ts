#!/usr/bin/env bun

import { appendFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

import {
    acquireDesktopLease,
    inspectDesktopLease,
    releaseDesktopLease,
} from '../.agents/skills/switch-worktree/scripts/desktop-lease';
import { createE2EPoolPlan } from '../e2e/pools';

const projectRoot = resolve(import.meta.dirname, '..');
const parallelWorkers = 2;
export type E2EPool = 'desktop-exclusive' | 'parallel-safe';

export function parseE2EPool(args: readonly string[]): E2EPool {
    if (
        args.length !== 2 ||
        args[0] !== '--pool' ||
        (args[1] !== 'desktop-exclusive' && args[1] !== 'parallel-safe')
    ) {
        throw new Error('Usage: run-e2e-pools.ts --pool <parallel-safe|desktop-exclusive>');
    }
    return args[1];
}

async function discoverE2ESpecs(): Promise<string[]> {
    return (await readdir(resolve(projectRoot, 'e2e'), { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.e2e.ts'))
        .map((entry) => `e2e/${entry.name}`)
        .sort();
}

async function capturePlaywright(args: string[]): Promise<string> {
    const child = spawn('bunx', ['playwright', 'test', ...args], {
        cwd: projectRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('exit', (exitCode, signal) => resolveExit(exitCode ?? (signal ? 1 : 0)));
    });
    if (code !== 0) throw new Error(`Could not list E2E pool:\n${stderr || stdout}`);
    return stdout;
}

async function countTests(specs: readonly string[]): Promise<number> {
    const output = await capturePlaywright([...specs, '--list', '--reporter=list']);
    const total = /Total:\s+(\d+)\s+tests?/u.exec(output)?.[1];
    if (!total) throw new Error('Playwright list output did not include a test total');
    return Number(total);
}

async function runPool(
    specs: readonly string[],
    pool: E2EPool,
    workers: number,
    coordinatorToken?: string,
): Promise<number> {
    const child = spawn(
        'bunx',
        ['playwright', 'test', ...specs, `--workers=${workers}`, '--reporter=line'],
        {
            cwd: projectRoot,
            env: {
                ...process.env,
                CAXRI_E2E_OUTPUT_DIR: `test-results/${pool}`,
                CAXRI_E2E_POOL: pool,
                ...(coordinatorToken ? { CAXRI_E2E_COORDINATOR_TOKEN: coordinatorToken } : {}),
            },
            stdio: 'inherit',
        },
    );
    return await new Promise<number>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
    });
}

async function assertParallelLeasesReleased(): Promise<void> {
    for (let index = 0; index < parallelWorkers; index += 1) {
        const namespace = `e2e-worker-${index}`;
        const status = await inspectDesktopLease(projectRoot, { namespace });
        if (status.state !== 'free') {
            throw new Error(
                `Parallel E2E worker ${index} left a ${status.state} ${namespace} lease`,
            );
        }
    }
}

async function appendSummary(
    plan: ReturnType<typeof createE2EPoolPlan>,
    pool: E2EPool,
    count: number,
    result: number,
): Promise<void> {
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (!summary) return;
    const specs =
        pool === 'parallel-safe' ? plan.parallelSafe.length : plan.desktopExclusive.length;
    const workers = pool === 'parallel-safe' ? parallelWorkers : 1;
    await appendFile(
        summary,
        [
            '## E2E pool manifest',
            '',
            '| Pool | Specs | Tests | Workers | Result |',
            '| --- | ---: | ---: | ---: | --- |',
            `| \`${pool}\` | ${specs} | ${count} | ${workers} | ${result === 0 ? 'passed' : 'failed'} |`,
            '',
        ].join('\n'),
    );
}

async function main(): Promise<void> {
    const pool = parseE2EPool(process.argv.slice(2));
    const plan = createE2EPoolPlan(await discoverE2ESpecs());
    const specs = pool === 'parallel-safe' ? plan.parallelSafe : plan.desktopExclusive;
    const count = await countTests(specs);
    let result: number;
    if (pool === 'parallel-safe') {
        const coordinator = await acquireDesktopLease(
            projectRoot,
            'Parallel-safe E2E pool coordinator',
        );
        try {
            result = await runPool(specs, pool, parallelWorkers, coordinator.token);
        } finally {
            await releaseDesktopLease(coordinator);
        }
        await assertParallelLeasesReleased();
    } else {
        result = await runPool(specs, pool, 1);
    }
    await appendSummary(plan, pool, count, result);
    if (result !== 0) process.exitCode = 1;
}

if (import.meta.main) await main();
