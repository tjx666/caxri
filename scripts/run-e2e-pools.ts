#!/usr/bin/env bun

import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

import {
    acquireDesktopLease,
    inspectDesktopLease,
    releaseDesktopLease,
} from '../.agents/skills/switch-worktree/scripts/desktop-lease';
import { createE2EPoolPlan, type E2EPoolInvocation } from '../e2e/pools';
import {
    assertE2EPoolReceipt,
    summarizeE2ETests,
    type E2EPoolReceipt,
} from './reporters/e2e-receipt-reporter';

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

async function runInvocation(
    invocation: E2EPoolInvocation,
    pool: E2EPool,
    workers: number,
    receiptPath: string,
    coordinatorToken?: string,
): Promise<number> {
    const grep = invocation.grep ? ['--grep', invocation.grep] : [];
    const grepInvert = invocation.grepInvert ? ['--grep-invert', invocation.grepInvert] : [];
    const child = spawn(
        'bunx',
        [
            'playwright',
            'test',
            ...invocation.specs,
            ...grep,
            ...grepInvert,
            `--workers=${workers}`,
            '--reporter=line,./scripts/reporters/e2e-receipt-reporter.ts',
        ],
        {
            cwd: projectRoot,
            env: {
                ...process.env,
                CAXRI_E2E_OUTPUT_DIR: `test-results/${pool}`,
                CAXRI_E2E_POOL: pool,
                CAXRI_E2E_RECEIPT_PATH: receiptPath,
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

export function combinePoolReceipts(
    pool: E2EPool,
    receipts: readonly E2EPoolReceipt[],
): E2EPoolReceipt {
    for (const receipt of receipts) assertE2EPoolReceipt(receipt);
    if (receipts.length === 0 || receipts.some((receipt) => receipt.pool !== pool)) {
        throw new Error(`E2E ${pool} receipt invocations are incomplete`);
    }
    const tests = receipts.flatMap((receipt) => receipt.tests);
    if (new Set(tests.map((test) => test.id)).size !== tests.length) {
        throw new Error(`E2E ${pool} receipt invocations overlap in tests`);
    }
    const combined: E2EPoolReceipt = {
        failed: receipts.reduce((total, receipt) => total + receipt.failed, 0),
        finished: receipts.reduce((total, receipt) => total + receipt.finished, 0),
        finishedAt:
            receipts
                .map((receipt) => receipt.finishedAt)
                .sort()
                .at(-1) ?? '',
        hash: summarizeE2ETests(tests),
        passed: receipts.reduce((total, receipt) => total + receipt.passed, 0),
        planned: receipts.reduce((total, receipt) => total + receipt.planned, 0),
        pool,
        skipped: receipts.reduce((total, receipt) => total + receipt.skipped, 0),
        started: receipts.reduce((total, receipt) => total + receipt.started, 0),
        startedAt: receipts.map((receipt) => receipt.startedAt).sort()[0] ?? '',
        status: receipts.every((receipt) => receipt.status === 'passed') ? 'passed' : 'failed',
        tests,
    };
    assertE2EPoolReceipt(combined);
    return combined;
}

async function writeReceipt(path: string, receipt: E2EPoolReceipt): Promise<void> {
    await mkdir(resolve(path, '..'), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
}

async function runPool(
    invocations: readonly E2EPoolInvocation[],
    pool: E2EPool,
    workers: number,
    coordinatorToken?: string,
): Promise<{ receipt: E2EPoolReceipt; result: number }> {
    const receiptPaths = invocations.map(
        (_invocation, index) => `test-results/receipts/${pool}-${index}.json`,
    );
    let result = 0;
    for (const [index, invocation] of invocations.entries()) {
        const code = await runInvocation(
            invocation,
            pool,
            workers,
            receiptPaths[index],
            coordinatorToken,
        );
        result ||= code;
    }
    const receipts = await Promise.all(
        receiptPaths.map(
            async (path) => JSON.parse(await readFile(path, 'utf8')) as E2EPoolReceipt,
        ),
    );
    const receipt = combinePoolReceipts(pool, receipts);
    await writeReceipt(`test-results/receipts/${pool}.json`, receipt);
    return { receipt, result };
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
    receipt: E2EPoolReceipt,
    result: number,
): Promise<void> {
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (!summary) return;
    const invocations =
        pool === 'parallel-safe' ? plan.parallelSafeInvocations : plan.desktopExclusiveInvocations;
    const specs = new Set(invocations.flatMap((invocation) => invocation.specs)).size;
    const workers = pool === 'parallel-safe' ? parallelWorkers : 1;
    await appendFile(
        summary,
        [
            '## E2E pool execution',
            '',
            '| Pool | Specs | Planned | Started | Finished | Passed | Skipped | Failed | Workers | Result |',
            '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
            `| \`${pool}\` | ${specs} | ${receipt.planned} | ${receipt.started} | ${receipt.finished} | ${receipt.passed} | ${receipt.skipped} | ${receipt.failed} | ${workers} | ${result === 0 ? 'passed' : 'failed'} |`,
            '',
        ].join('\n'),
    );
}

async function main(): Promise<void> {
    const pool = parseE2EPool(process.argv.slice(2));
    const plan = createE2EPoolPlan(await discoverE2ESpecs());
    const invocations =
        pool === 'parallel-safe' ? plan.parallelSafeInvocations : plan.desktopExclusiveInvocations;
    let execution: { receipt: E2EPoolReceipt; result: number };
    if (pool === 'parallel-safe') {
        const coordinator = await acquireDesktopLease(
            projectRoot,
            'Parallel-safe E2E pool coordinator',
        );
        try {
            execution = await runPool(invocations, pool, parallelWorkers, coordinator.token);
        } finally {
            await releaseDesktopLease(coordinator);
        }
        await assertParallelLeasesReleased();
    } else {
        execution = await runPool(invocations, pool, 1);
    }
    await appendSummary(plan, pool, execution.receipt, execution.result);
    if (execution.result !== 0) process.exitCode = 1;
}

if (import.meta.main) await main();
