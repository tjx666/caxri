#!/usr/bin/env bun

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { writeJsonAtomic } from './atomic-json';
import { prepareChecksWorktree } from './ci-checks-worktree';
import { sanitizedChildEnvironment } from './ci-child-environment';
import type {
    ConcurrentValidationProvenance,
    ConcurrentValidationReceipt,
} from './ci-concurrent-validation-report';
import {
    publishConcurrentValidationFailureSummary,
    publishConcurrentValidationOutcome,
    receiptPath,
} from './ci-concurrent-validation-report';
import { SKIP_GATE_ARGUMENTS } from './ci-platform-gates';
import { waitForChildExit } from './exec';

const projectRoot = resolve(import.meta.dirname, '..');

/**
 * ESLint, Vitest, and the bundle budget run in their own hosted jobs on this route too. On the shared 3-core `macos-15`
 * runner, cold ESLint beside the Electron pools took 1170 s at two workers and never finished at `auto`, which alone
 * aborted the 25-minute window (#1869).
 */
const SPLIT_GATE_ARGUMENTS = Object.keys(SKIP_GATE_ARGUMENTS);

type ConcurrentValidationComponent =
    'checks' | 'desktop-exclusive' | 'e2e-auxiliary' | 'parallel-safe';

type E2EValidationResults = Omit<ConcurrentValidationReceipt, 'checks' | 'provenance' | 'version'>;

interface ConcurrentValidationProcessOperations {
    clearForceTimer: (timer: ReturnType<typeof setTimeout>) => void;
    setForceTimer: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
    signalProcessGroup: (child: ChildProcess, signal: NodeJS.Signals) => void;
    spawnProcess: (
        command: string,
        arguments_: readonly string[],
        options: SpawnOptions,
    ) => ChildProcess;
}

interface ConcurrentValidationRunPolicy {
    abortOnFailure?: boolean;
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
}

const defaultProcessOperations: ConcurrentValidationProcessOperations = {
    clearForceTimer: clearTimeout,
    setForceTimer: setTimeout,
    signalProcessGroup,
    spawnProcess: spawn,
};

/**
 * Owns detached process groups for both concurrent branches. Failures abort siblings by default; independently
 * receipted E2E components can preserve the other receipts, while the force timer prevents a child that ignores SIGTERM
 * from withholding the shared receipt.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- regression-tested by the concurrent CI contract
export class ConcurrentValidationProcesses {
    private readonly active = new Set<ChildProcess>();
    private readonly forceTimers = new Map<ChildProcess, ReturnType<typeof setTimeout>>();
    private readonly operations: ConcurrentValidationProcessOperations;
    private isAborted = false;
    private abortedReason: string | undefined;

    constructor(operations: Partial<ConcurrentValidationProcessOperations> = {}) {
        this.operations = { ...defaultProcessOperations, ...operations };
    }

    private signal(child: ChildProcess, signal: NodeJS.Signals): void {
        try {
            this.operations.signalProcessGroup(child, signal);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
                console.error(`Could not send ${signal} to a validation process group:`, error);
            }
        }
    }

    private release(child: ChildProcess): void {
        this.active.delete(child);
        const timer = this.forceTimers.get(child);
        if (timer) this.operations.clearForceTimer(timer);
        this.forceTimers.delete(child);
    }

    async run(
        command: string,
        arguments_: readonly string[],
        options: SpawnOptions,
        policy: ConcurrentValidationRunPolicy = {},
    ): Promise<number | null> {
        if (this.isAborted) return null;
        const child = this.operations.spawnProcess(command, arguments_, {
            ...options,
            detached: process.platform !== 'win32',
        });
        this.active.add(child);
        try {
            const result = await waitForChildExit(child);
            if (result !== 0 && policy.abortOnFailure !== false) {
                this.release(child);
                this.abort(`${command} failed with exit ${result}`);
            }
            return result;
        } finally {
            this.release(child);
        }
    }

    async capture(
        command: string,
        arguments_: readonly string[],
        options: Pick<SpawnOptions, 'cwd' | 'env'> = {},
    ): Promise<{ stderr: string; stdout: string }> {
        if (this.isAborted) throw new Error('Concurrent validation is already aborted');
        const child = this.operations.spawnProcess(command, arguments_, {
            ...options,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.active.add(child);
        let stderr = '';
        let stdout = '';
        child.stderr?.setEncoding('utf8');
        child.stdout?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            stderr += chunk;
        });
        child.stdout?.on('data', (chunk: string) => {
            stdout += chunk;
        });
        try {
            const result = await waitForChildExit(child, { event: 'close' });
            if (result !== 0) {
                throw Object.assign(new Error(`${command} failed with exit ${result}`), {
                    code: result,
                    stderr,
                    stdout,
                });
            }
            return { stderr, stdout };
        } finally {
            this.release(child);
        }
    }

    /**
     * Why the run was aborted, or `undefined` when every component ran to its own exit.
     */
    get abortReason(): string | undefined {
        return this.abortedReason;
    }

    abort(reason: string): void {
        if (this.isAborted) return;
        this.isAborted = true;
        this.abortedReason = reason;
        console.error(`Concurrent validation aborted: ${reason}`);
        for (const child of this.active) {
            this.signal(child, 'SIGTERM');
            const timer = this.operations.setForceTimer(() => {
                if (this.active.has(child)) this.signal(child, 'SIGKILL');
            }, 2_000);
            this.forceTimers.set(child, timer);
        }
    }
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- regression-tested by the concurrent CI contract
export function scheduleConcurrentValidationDeadline(
    processes: ConcurrentValidationProcesses,
    milliseconds = 25 * 60 * 1_000,
): ReturnType<typeof setTimeout> {
    return setTimeout(
        () => processes.abort('concurrent validation exceeded 25 minutes'),
        milliseconds,
    );
}

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
        !isOptionalExitCode(receipt.e2eSetup) ||
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
    processes: ConcurrentValidationProcesses,
    command: string,
    arguments_: string[],
    options: {
        abortOnFailure?: boolean;
        cwd?: string;
        environment?: NodeJS.ProcessEnv;
        label: string;
    },
): Promise<number | null> {
    try {
        const result = await processes.run(
            command,
            arguments_,
            {
                cwd: options.cwd ?? projectRoot,
                env: options.environment,
                stdio: 'inherit',
            },
            {
                abortOnFailure: options.abortOnFailure,
            },
        );
        if (result === null) return null;
        if (result !== 0) {
            console.error(`${options.label} failed with exit ${result}.`);
            if (options.abortOnFailure !== false) {
                processes.abort(`${options.label} failed with exit ${result}`);
            }
        }
        return result;
    } catch (error) {
        console.error(`${options.label} could not start:`, error);
        processes.abort(`${options.label} could not start`);
        return 1;
    }
}

/**
 * Records one E2E component without destroying full-check or later E2E receipts. A deterministic full-check failure and
 * the shared deadline still use the default fail-fast policy and terminate every active child.
 */
function runReceiptedE2E(
    processes: ConcurrentValidationProcesses,
    command: string,
    arguments_: string[],
    options: { environment: NodeJS.ProcessEnv; label: string },
): Promise<number | null> {
    return run(processes, command, arguments_, { ...options, abortOnFailure: false });
}

function measured(label: string, command: string, arguments_: string[]): string[] {
    return ['run', 'scripts/ci-metrics.ts', '--label', label, '--', command, ...arguments_];
}

type E2ESetupRunner = (
    label: string,
    command: string,
    arguments_: string[],
) => Promise<number | null>;

// eslint-disable-next-line unicorn/no-exports-in-scripts -- regression-tested by the concurrent CI contract
export async function runE2ESetup(execute: E2ESetupRunner): Promise<number | null> {
    const build = await execute('Electron Vite build', 'bun', ['run', 'build']);
    if (build !== 0) return build;
    return execute('Electron native compatibility', 'bun', ['run', 'spike:native']);
}

async function runE2E(
    environment: NodeJS.ProcessEnv,
    processes: ConcurrentValidationProcesses,
): Promise<E2EValidationResults> {
    /**
     * The native probe consumes the built standalone Server artifact and the compiled client package that resolves it.
     * A lifecycle-free CI install intentionally creates neither output, so the complete build must precede the probe.
     */
    const e2eSetup = await runE2ESetup((label, command, arguments_) =>
        runReceiptedE2E(processes, 'bun', measured(label, command, arguments_), {
            environment,
            label,
        }),
    );
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

    const failureIsolation = await runReceiptedE2E(
        processes,
        'bun',
        measured('Desktop worker interruption recovery', 'bun', [
            'run',
            'scripts/run-e2e-failure-isolation.ts',
        ]),
        { environment, label: 'Desktop worker interruption recovery' },
    );
    const failureCensus = await runReceiptedE2E(
        processes,
        'bun',
        ['run', 'scripts/run-e2e-census-fixture.ts'],
        {
            environment,
            label: 'Bounded E2E failure census',
        },
    );
    /**
     * The single-worker work runs first on purpose. Both pools always run: {@link runReceiptedE2E} never aborts a
     * sibling, so order only decides what shares the runner with the CPU-heavy platform-checks branch (ESLint plus
     * Vitest). The exclusive pool and dispatch-only CI parity barely compete for cores, so they fill that window and
     * the three-worker pool mostly follows it. Parity used to run last, where its ~200s pushed every manual full run
     * past the shared deadline (issue #1846).
     */
    const desktopExclusive = await runReceiptedE2E(
        processes,
        'bun',
        measured('Playwright desktop-exclusive workers=1', 'bun', [
            'run',
            'scripts/run-e2e-pools.ts',
            '--pool',
            'desktop-exclusive',
        ]),
        { environment, label: 'Desktop-exclusive E2E pool' },
    );
    const ciParity =
        process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
            ? await runReceiptedE2E(
                  processes,
                  'bun',
                  measured('CI parity workers=1 repeat=3', 'bun', [
                      'run',
                      'scripts/run-ci-parity.ts',
                  ]),
                  { environment, label: 'Deterministic CI-parity cases' },
              )
            : 0;
    const parallelWorkers = process.env.CAXRI_E2E_PARALLEL_WORKERS ?? '3';
    const parallelSafe = await runReceiptedE2E(
        processes,
        'bun',
        measured(`Playwright parallel-safe workers=${parallelWorkers}`, 'bun', [
            'run',
            'scripts/run-e2e-pools.ts',
            '--pool',
            'parallel-safe',
        ]),
        { environment, label: 'Parallel-safe E2E pool' },
    );
    const manifest = await runReceiptedE2E(
        processes,
        'bun',
        ['run', 'scripts/report-e2e-manifest.ts', 'parallel-safe', 'desktop-exclusive'],
        { environment, label: 'E2E execution receipt' },
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
    await writeJsonAtomic(receiptPath, receipt, { ensureParent: true });
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-concurrent-validation.test.ts
export function isVerificationPassed(
    receipt: ConcurrentValidationReceipt,
    component: ConcurrentValidationComponent,
    expectedProvenance: ConcurrentValidationProvenance,
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
    const provenance = concurrentValidationProvenance(process.env);
    await rm(receiptPath, { force: true });
    const safeEnvironment = sanitizedChildEnvironment(process.env);
    const processes = new ConcurrentValidationProcesses();
    const deadline = scheduleConcurrentValidationDeadline(processes);
    const checksPromise = (async (): Promise<number> => {
        try {
            const { checksEnvironment, worktree } = await prepareChecksWorktree(process.env, {
                execFile: (command, arguments_, options) =>
                    processes.capture(command, arguments_, options),
                runChildProcess: async (command, arguments_, options) =>
                    (await processes.run(command, arguments_, options ?? {})) ?? 1,
            });
            return (
                (await run(
                    processes,
                    'bun',
                    [
                        'run',
                        'scripts/ci-platform-checks.ts',
                        '--skip-node-pty-preparation',
                        ...SPLIT_GATE_ARGUMENTS,
                    ],
                    {
                        cwd: worktree,
                        environment: checksEnvironment,
                        label: 'Full platform checks',
                    },
                )) ?? 1
            );
        } catch (error) {
            console.error('Full platform checks could not prepare:', error);
            processes.abort('full platform checks could not prepare');
            return 1;
        }
    })();
    const e2ePromise = runE2E(safeEnvironment, processes);
    try {
        const [checks, e2e] = await Promise.all([checksPromise, e2ePromise]);
        const receipt = { checks, ...e2e, provenance, version: 1 as const };
        await writeReceipt(receipt);
        await publishConcurrentValidationFailureSummary(receipt);
        await publishConcurrentValidationOutcome(processes);
    } finally {
        clearTimeout(deadline);
    }
}

async function verify(component: ConcurrentValidationComponent): Promise<void> {
    const receipt = parseConcurrentValidationReceipt(
        JSON.parse(await readFile(receiptPath, 'utf8')),
    );
    if (!isVerificationPassed(receipt, component, concurrentValidationProvenance(process.env))) {
        await publishConcurrentValidationFailureSummary(receipt);
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
