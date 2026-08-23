#!/usr/bin/env bun

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

interface ConcurrentValidationProvenance {
    checksRevision: string;
    exactHead: string;
    parallelWorkers: number;
    profile: 'optimized';
    runAttempt: string;
    runId: string;
}

interface ConcurrentValidationReceipt {
    checks: number;
    ciParity: number | null;
    desktopExclusive: number | null;
    e2eSetup: number;
    failureCensus: number | null;
    failureIsolation: number | null;
    manifest: number | null;
    parallelSafe: number | null;
    provenance: ConcurrentValidationProvenance;
    version: 1;
}

type E2EValidationResults = Omit<ConcurrentValidationReceipt, 'checks' | 'provenance' | 'version'>;

function requiredEnvironment(environment: NodeJS.ProcessEnv, key: string): string {
    const value = environment[key];
    if (!value || value.includes('\n')) throw new Error(`${key} is required and must be one line`);
    return value;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-concurrent-validation.test.ts
export function concurrentValidationProvenance(
    environment: NodeJS.ProcessEnv,
): ConcurrentValidationProvenance {
    const exactHead = requiredEnvironment(environment, 'CAXRI_EXPECTED_HEAD');
    const checksRevision = requiredEnvironment(environment, 'CAXRI_CHECKS_REVISION');
    if (!/^[0-9a-f]{40}$/u.test(exactHead) || !/^[0-9a-f]{40}$/u.test(checksRevision)) {
        throw new Error('Invalid concurrent validation revision');
    }
    const parallelWorkers = requiredEnvironment(environment, 'CAXRI_E2E_PARALLEL_WORKERS');
    if (!['2', '3', '4'].includes(parallelWorkers)) {
        throw new Error('Invalid concurrent validation worker count');
    }
    const profile = requiredEnvironment(environment, 'CAXRI_E2E_PROFILE');
    if (profile !== 'optimized') throw new Error('Concurrent validation requires optimized E2E');
    const runAttempt = requiredEnvironment(environment, 'GITHUB_RUN_ATTEMPT');
    const runId = requiredEnvironment(environment, 'GITHUB_RUN_ID');
    if (!/^[1-9]\d*$/u.test(runId) || !/^[1-9]\d*$/u.test(runAttempt)) {
        throw new Error('Invalid concurrent validation run identity');
    }
    return {
        checksRevision,
        exactHead,
        parallelWorkers: Number(parallelWorkers),
        profile,
        runAttempt,
        runId,
    };
}

function isExitCode(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isOptionalExitCode(value: unknown): value is number | null {
    return value === null || isExitCode(value);
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-concurrent-validation.test.ts
export function parseConcurrentValidationReceipt(value: unknown): ConcurrentValidationReceipt {
    if (!value || typeof value !== 'object')
        throw new Error('Invalid concurrent validation receipt');
    const receipt = value as Partial<ConcurrentValidationReceipt>;
    const provenance = (value as { provenance?: Partial<ConcurrentValidationProvenance> })
        .provenance;
    if (
        !provenance ||
        typeof provenance !== 'object' ||
        receipt.version !== 1 ||
        !/^[0-9a-f]{40}$/u.test(provenance.checksRevision ?? '') ||
        !/^[0-9a-f]{40}$/u.test(provenance.exactHead ?? '') ||
        ![2, 3, 4].includes(provenance.parallelWorkers ?? 0) ||
        provenance.profile !== 'optimized' ||
        !/^[1-9]\d*$/u.test(provenance.runAttempt ?? '') ||
        !/^[1-9]\d*$/u.test(provenance.runId ?? '') ||
        !isExitCode(receipt.checks) ||
        !isExitCode(receipt.e2eSetup) ||
        ![
            receipt.ciParity,
            receipt.desktopExclusive,
            receipt.failureCensus,
            receipt.failureIsolation,
            receipt.manifest,
            receipt.parallelSafe,
        ].every(isOptionalExitCode)
    ) {
        throw new Error('Invalid concurrent validation receipt');
    }
    return receipt as ConcurrentValidationReceipt;
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

async function runE2E(): Promise<E2EValidationResults> {
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
    expectedProvenance: ConcurrentValidationProvenance = receipt.provenance,
): boolean {
    if (JSON.stringify(receipt.provenance) !== JSON.stringify(expectedProvenance)) return false;
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
    const provenance = concurrentValidationProvenance(process.env);
    await rm(receiptPath, { force: true });
    const checksPromise = run('bun', ['run', 'scripts/ci-platform-checks.ts'], {
        cwd: checksWorktree,
        label: 'Full platform checks',
    });
    const [checks, e2e] = await Promise.all([checksPromise, runE2E()]);
    await writeReceipt({ checks, ...e2e, provenance, version: 1 });
}

async function verify(component: ConcurrentValidationComponent): Promise<void> {
    const receipt = parseConcurrentValidationReceipt(
        JSON.parse(await readFile(receiptPath, 'utf8')),
    );
    if (!isVerificationPassed(receipt, component, concurrentValidationProvenance(process.env))) {
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
