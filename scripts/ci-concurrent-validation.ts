#!/usr/bin/env bun

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { runChildProcess } from './exec';

const projectRoot = resolve(import.meta.dirname, '..');
const receiptPath = resolve(
    projectRoot,
    'test-results',
    'receipts',
    'ci-concurrent-validation.json',
);

type ConcurrentValidationComponent =
    'checks' | 'desktop-exclusive' | 'e2e-auxiliary' | 'parallel-safe';

interface ConcurrentValidationReceipt {
    checks: number;
    ciParity: number | null;
    desktopExclusive: number | null;
    e2eSetup: number;
    failureCensus: number | null;
    failureIsolation: number | null;
    manifest: number | null;
    parallelSafe: number | null;
}

async function run(
    command: string,
    arguments_: string[],
    options: { cwd?: string; label: string },
): Promise<number> {
    try {
        const result = await runChildProcess(command, arguments_, {
            cwd: options.cwd ?? projectRoot,
            stdio: 'inherit',
        });
        if (result !== 0) console.error(`${options.label} failed with exit ${result}.`);
        return result;
    } catch (error) {
        console.error(`${options.label} could not start:`, error);
        return 1;
    }
}

function measured(label: string, command: string, arguments_: string[]): string[] {
    return ['run', 'scripts/ci-metrics.ts', '--label', label, '--', command, ...arguments_];
}

async function runE2E(): Promise<Omit<ConcurrentValidationReceipt, 'checks'>> {
    const spike = await run(
        'bun',
        measured('Electron native compatibility', 'bun', ['run', 'spike:native']),
        {
            label: 'Electron native compatibility',
        },
    );
    const build =
        spike === 0
            ? await run('bun', measured('Electron Vite build', 'bun', ['run', 'build']), {
                  label: 'Electron Vite build',
              })
            : 1;
    const e2eSetup = spike || build;
    if (e2eSetup !== 0) {
        return {
            ciParity: null,
            desktopExclusive: null,
            e2eSetup,
            failureCensus: null,
            failureIsolation: null,
            manifest: null,
            parallelSafe: null,
        };
    }

    const failureIsolation = await run(
        'bun',
        measured('Desktop worker interruption recovery', 'bun', [
            'run',
            'scripts/run-e2e-failure-isolation.ts',
        ]),
        { label: 'Desktop worker interruption recovery' },
    );
    const failureCensus = await run('bun', ['run', 'scripts/run-e2e-census-fixture.ts'], {
        label: 'Bounded E2E failure census',
    });
    const parallelWorkers = process.env.CAXRI_E2E_PARALLEL_WORKERS ?? '3';
    const parallelSafe = await run(
        'bun',
        measured(`Playwright parallel-safe workers=${parallelWorkers}`, 'bun', [
            'run',
            'scripts/run-e2e-pools.ts',
            '--pool',
            'parallel-safe',
        ]),
        { label: 'Parallel-safe E2E pool' },
    );
    const desktopExclusive = await run(
        'bun',
        measured('Playwright desktop-exclusive workers=1', 'bun', [
            'run',
            'scripts/run-e2e-pools.ts',
            '--pool',
            'desktop-exclusive',
        ]),
        { label: 'Desktop-exclusive E2E pool' },
    );
    const ciParity =
        process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
            ? await run(
                  'bun',
                  measured('CI parity workers=1 repeat=3', 'bun', [
                      'run',
                      'scripts/run-ci-parity.ts',
                  ]),
                  { label: 'Deterministic CI-parity cases' },
              )
            : 0;
    const manifest = await run(
        'bun',
        ['run', 'scripts/report-e2e-manifest.ts', 'parallel-safe', 'desktop-exclusive'],
        { label: 'E2E execution receipt' },
    );
    return {
        ciParity,
        desktopExclusive,
        e2eSetup,
        failureCensus,
        failureIsolation,
        manifest,
        parallelSafe,
    };
}

async function writeReceipt(receipt: ConcurrentValidationReceipt): Promise<void> {
    await mkdir(resolve(receiptPath, '..'), { recursive: true });
    const temporary = `${receiptPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await rename(temporary, receiptPath);
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-concurrent-validation.test.ts
export function isVerificationPassed(
    receipt: ConcurrentValidationReceipt,
    component: ConcurrentValidationComponent,
): boolean {
    if (component === 'checks') return receipt.checks === 0;
    if (component === 'parallel-safe') return receipt.parallelSafe === 0;
    if (component === 'desktop-exclusive') return receipt.desktopExclusive === 0;
    return [
        receipt.e2eSetup,
        receipt.failureIsolation,
        receipt.failureCensus,
        receipt.ciParity,
        receipt.manifest,
    ].every((result) => result === 0);
}

async function execute(): Promise<void> {
    const checksWorktree = process.env.CAXRI_CHECKS_WORKTREE;
    if (!checksWorktree) throw new Error('CAXRI_CHECKS_WORKTREE is required');
    const checksPromise = run('bun', ['run', 'scripts/ci-platform-checks.ts'], {
        cwd: checksWorktree,
        label: 'Full platform checks',
    });
    const [checks, e2e] = await Promise.all([checksPromise, runE2E()]);
    await writeReceipt({ checks, ...e2e });
}

async function verify(component: ConcurrentValidationComponent): Promise<void> {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as ConcurrentValidationReceipt;
    if (!isVerificationPassed(receipt, component)) {
        throw new Error(`${component} validation failed: ${JSON.stringify(receipt)}`);
    }
}

async function main(): Promise<void> {
    const [command, component, extra] = process.argv.slice(2);
    if (command === 'run' && !component) await execute();
    else if (
        command === 'verify' &&
        !extra &&
        ['checks', 'desktop-exclusive', 'e2e-auxiliary', 'parallel-safe'].includes(component)
    ) {
        await verify(component as ConcurrentValidationComponent);
    } else {
        throw new Error(
            'Usage: ci-concurrent-validation.ts <run|verify checks|desktop-exclusive|e2e-auxiliary|parallel-safe>',
        );
    }
}

if (import.meta.main) await main();
