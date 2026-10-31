import type { ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import {
    authenticatedGitEnvironment,
    checksWorktreePath,
    createFetchedCheckout,
    verifyRevisionProvenance,
} from '../ci-checks-worktree';
import {
    ConcurrentValidationProcesses,
    concurrentValidationProvenance,
    isVerificationPassed,
    parseConcurrentValidationReceipt,
    runE2ESetup,
    scheduleConcurrentValidationDeadline,
} from '../ci-concurrent-validation';
import {
    formatConcurrentValidationFailureSummary,
    publishConcurrentValidationOutcome,
} from '../ci-concurrent-validation-report';
import { platformCheckCommands } from '../ci-platform-checks';
import {
    EXPECTED_PLATFORM_NEUTRAL_GATE_IDS,
    EXPECTED_PLATFORM_NEUTRAL_GATE_LABELS,
} from './ci-platform-gates.fixture';

const greenReceipt = {
    checks: 0,
    desktopExclusive: 0,
    e2eSetup: 0,
    failureCensus: 0,
    failureIsolation: 0,
    manifest: 0,
    parallelSafe: 0,
    provenance: {
        checksRevision: 'b'.repeat(40),
        exactHead: 'a'.repeat(40),
        parallelWorkers: 3,
        profile: 'optimized' as const,
        runAttempt: '1',
        runId: '123',
    },
    version: 1 as const,
};

const execFileAsync = promisify(execFile);

describe('concurrent CI validation', () => {
    it('stays silent for a green receipt', () => {
        expect(formatConcurrentValidationFailureSummary(greenReceipt)).toBeUndefined();
    });

    it('lists every non-zero component with its exit code, log hint, and receipt path', () => {
        const summary = formatConcurrentValidationFailureSummary(
            { ...greenReceipt, checks: 1, failureCensus: 2, parallelSafe: 1 },
            '/tmp/ci-concurrent-validation.json',
        );
        expect(summary).toContain('- checks: exit 1.');
        expect(summary).toContain('- failureCensus: exit 2.');
        expect(summary).toContain('- parallelSafe: exit 1.');
        expect(summary).toContain('Full platform checks failed with exit');
        expect(summary).toContain('Full platform checks could not prepare');
        expect(summary).toContain('Full platform checks could not start');
        expect(summary).toContain('Bounded E2E failure census failed with exit');
        expect(summary).toContain('Bounded E2E failure census could not start');
        expect(summary).toContain('Parallel-safe E2E pool failed with exit');
        expect(summary).toContain('Parallel-safe E2E pool could not start');
        expect(summary).toContain('Receipt: /tmp/ci-concurrent-validation.json');
        expect(summary).not.toContain('e2eSetup');
        expect(summary).not.toContain('desktopExclusive');
    });

    it('does not list skipped null components as failures', () => {
        const summary = formatConcurrentValidationFailureSummary({
            ...greenReceipt,
            e2eSetup: 1,
            desktopExclusive: null,
            failureCensus: null,
            failureIsolation: null,
            manifest: null,
            parallelSafe: null,
        });
        expect(summary).toContain('- e2eSetup: exit 1.');
        expect(summary).not.toContain('desktopExclusive');
        expect(summary).not.toContain('failureCensus');
        expect(summary).not.toContain('parallelSafe');
    });

    it('omits unstarted E2E components when checks fail before they spawn', () => {
        const summary = formatConcurrentValidationFailureSummary({
            ...greenReceipt,
            checks: 1,
            desktopExclusive: null,
            e2eSetup: null,
            failureCensus: null,
            failureIsolation: null,
            manifest: null,
            parallelSafe: null,
        });
        expect(summary).toContain('- checks: exit 1.');
        expect(summary).not.toContain('e2eSetup');
        expect(summary).not.toContain('failureIsolation');
        expect(summary).not.toContain('failureCensus');
        expect(summary).not.toContain('parallelSafe');
        expect(summary).not.toContain('desktopExclusive');
        expect(summary).not.toContain('manifest');
        expect(
            parseConcurrentValidationReceipt({
                ...greenReceipt,
                checks: 1,
                desktopExclusive: null,
                e2eSetup: null,
                failureCensus: null,
                failureIsolation: null,
                manifest: null,
                parallelSafe: null,
            }),
        ).toMatchObject({ checks: 1, e2eSetup: null });
    });

    it('terminates a sibling process group after a non-zero child exit', async () => {
        // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess exposes Node EventEmitter events.
        const failedChild = new EventEmitter() as ChildProcess;
        Object.defineProperty(failedChild, 'pid', { value: 4241 });
        // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess exposes Node EventEmitter events.
        const siblingChild = new EventEmitter() as ChildProcess;
        Object.defineProperty(siblingChild, 'pid', { value: 4242 });
        const children = [failedChild, siblingChild];
        const signals: Array<{ signal: NodeJS.Signals; target: ChildProcess }> = [];
        const forceTimers: Array<() => void> = [];
        const runner = new ConcurrentValidationProcesses({
            clearForceTimer: () => {},
            setForceTimer: (callback) => {
                const timer = setTimeout(callback, 60_000);
                forceTimers.push(() => {
                    clearTimeout(timer);
                    callback();
                });
                return timer;
            },
            signalProcessGroup: (target, signal) => signals.push({ signal, target }),
            spawnProcess: () => children.shift() as ChildProcess,
        });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            const failed = runner.run('failed-fixture', [], { stdio: 'ignore' });
            const sibling = runner.run('sibling-fixture', [], { stdio: 'ignore' });
            failedChild.emit('exit', 7, null);

            await expect(failed).resolves.toBe(7);
            expect(signals).toEqual([{ signal: 'SIGTERM', target: siblingChild }]);
            expect(forceTimers).toHaveLength(1);
            forceTimers[0]();
            siblingChild.emit('exit', null, 'SIGTERM');

            await expect(sibling).resolves.toBe(1);
            await expect(runner.run('skipped', [], { stdio: 'ignore' })).resolves.toBeNull();
            expect(signals).toEqual([
                { signal: 'SIGTERM', target: siblingChild },
                { signal: 'SIGKILL', target: siblingChild },
            ]);
            expect(error).toHaveBeenCalledWith(
                'Concurrent validation aborted: failed-fixture failed with exit 7',
            );
        } finally {
            error.mockRestore();
            for (const timer of forceTimers) timer();
        }
    });

    it('preserves sibling receipts after an isolated component fails', async () => {
        // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess exposes Node EventEmitter events.
        const failedChild = new EventEmitter() as ChildProcess;
        Object.defineProperty(failedChild, 'pid', { value: 4251 });
        // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess exposes Node EventEmitter events.
        const siblingChild = new EventEmitter() as ChildProcess;
        Object.defineProperty(siblingChild, 'pid', { value: 4252 });
        // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess exposes Node EventEmitter events.
        const laterChild = new EventEmitter() as ChildProcess;
        Object.defineProperty(laterChild, 'pid', { value: 4253 });
        const children = [failedChild, siblingChild, laterChild];
        const signals: NodeJS.Signals[] = [];
        const runner = new ConcurrentValidationProcesses({
            signalProcessGroup: (_target, signal) => signals.push(signal),
            spawnProcess: () => children.shift() as ChildProcess,
        });

        const failed = runner.run(
            'isolated-e2e',
            [],
            { stdio: 'ignore' },
            { abortOnFailure: false },
        );
        const sibling = runner.run('full-checks', [], { stdio: 'ignore' });
        failedChild.emit('exit', 7, null);

        await expect(failed).resolves.toBe(7);
        expect(signals).toEqual([]);

        const later = runner.run('later-e2e', [], { stdio: 'ignore' });
        laterChild.emit('exit', 0, null);
        siblingChild.emit('exit', 0, null);

        await expect(Promise.all([sibling, later])).resolves.toEqual([0, 0]);
        expect(signals).toEqual([]);
    });

    it('aborts active validation when the shared deadline expires', () => {
        vi.useFakeTimers();
        const runner = new ConcurrentValidationProcesses();
        const abort = vi.spyOn(runner, 'abort').mockImplementation(() => {});

        try {
            scheduleConcurrentValidationDeadline(runner, 25);
            vi.advanceTimersByTime(24);
            expect(abort).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(abort).toHaveBeenCalledWith('concurrent validation exceeded 25 minutes');
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('reports an aborted run so the Renderer performance gate can skip it (issue #1852)', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-concurrent-outcome-'));
        const output = join(directory, 'output');
        const summary = join(directory, 'summary');
        const runner = new ConcurrentValidationProcesses();
        try {
            await publishConcurrentValidationOutcome(runner, { output, summary });
            expect(await readFile(output, 'utf8')).toBe('aborted=false\n');
            await expect(access(summary)).rejects.toThrow();

            runner.abort('concurrent validation exceeded 25 minutes');
            await publishConcurrentValidationOutcome(runner, { output, summary });
            expect(await readFile(output, 'utf8')).toBe('aborted=false\naborted=true\n');
            expect(await readFile(summary, 'utf8')).toContain(
                'Renderer performance gate skipped: concurrent validation aborted (concurrent validation exceeded 25 minutes)',
            );
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it('cancels captured Git subprocesses through the same owned process group', async () => {
        // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess exposes Node EventEmitter events.
        const child = new EventEmitter() as ChildProcess;
        Object.defineProperties(child, {
            pid: { value: 4243 },
            stderr: { value: new PassThrough() },
            stdout: { value: new PassThrough() },
        });
        const signals: NodeJS.Signals[] = [];
        const runner = new ConcurrentValidationProcesses({
            signalProcessGroup: (_target, signal) => signals.push(signal),
            spawnProcess: () => child,
        });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            const capture = runner.capture('git', ['fetch']);
            runner.abort('checkout deadline');
            child.emit('close', null, 'SIGTERM');

            await expect(capture).rejects.toThrow('git failed with exit 1');
            expect(signals).toEqual(['SIGTERM']);
        } finally {
            error.mockRestore();
        }
    });

    it('allows an expected captured Git probe failure without aborting later commands', async () => {
        // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess exposes Node EventEmitter events.
        const probe = new EventEmitter() as ChildProcess;
        Object.defineProperties(probe, {
            pid: { value: 4244 },
            stderr: { value: new PassThrough() },
            stdout: { value: new PassThrough() },
        });
        // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess exposes Node EventEmitter events.
        const next = new EventEmitter() as ChildProcess;
        Object.defineProperty(next, 'pid', { value: 4245 });
        const children = [probe, next];
        const runner = new ConcurrentValidationProcesses({
            spawnProcess: () => children.shift() as ChildProcess,
        });

        const captured = runner.capture('git', ['cat-file', '-e', 'missing']);
        probe.emit('close', 1, null);
        await expect(captured).rejects.toThrow('git failed with exit 1');

        const following = runner.run('git', ['fetch'], { stdio: 'ignore' });
        next.emit('exit', 0, null);
        await expect(following).resolves.toBe(0);
    });

    it('does not spawn a child that was aborted before start', async () => {
        const runner = new ConcurrentValidationProcesses({
            spawnProcess: () => {
                throw new Error('aborted components must not spawn');
            },
        });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            runner.abort('full platform checks failed with exit 1');
            await expect(runner.run('e2e-setup', [], { stdio: 'ignore' })).resolves.toBeNull();
        } finally {
            error.mockRestore();
        }
    });

    it('builds the standalone Server artifact before probing it', async () => {
        const labels: string[] = [];
        const result = await runE2ESetup((label) => {
            labels.push(label);
            return Promise.resolve(0);
        });

        expect(result).toBe(0);
        expect(labels).toEqual(['Electron Vite build', 'Electron native compatibility']);
    });

    it('does not probe a Server artifact when its build failed', async () => {
        const labels: string[] = [];
        const result = await runE2ESetup((label) => {
            labels.push(label);
            return Promise.resolve(7);
        });

        expect(result).toBe(7);
        expect(labels).toEqual(['Electron Vite build']);
    });

    it('does not probe a Server artifact when setup was skipped before spawn', async () => {
        const labels: string[] = [];
        const result = await runE2ESetup((label) => {
            labels.push(label);
            return Promise.resolve(null);
        });

        expect(result).toBeNull();
        expect(labels).toEqual(['Electron Vite build']);
    });

    it('retains every full platform gate in its original fail-fast order', () => {
        const checks = platformCheckCommands({
            CAXRI_VITEST_MAX_WORKERS: '2',
            CAXRI_VITEST_PARTITION: 'optimized',
            ESLINT_CONCURRENCY: 'off',
        });

        expect(checks.map(({ label }) => label)).toEqual([
            'node-pty spawn helper',
            ...EXPECTED_PLATFORM_NEUTRAL_GATE_LABELS,
        ]);
        expect(checks.slice(1).map(({ id }) => id)).toEqual(EXPECTED_PLATFORM_NEUTRAL_GATE_IDS);
        expect(checks[0]).toEqual({
            arguments: ['run', 'scripts/prepare-node-pty.ts'],
            command: 'bun',
            id: 'node-pty-preparation',
            label: 'node-pty spawn helper',
        });
        expect(checks.at(-1)?.arguments).toContain('scripts/ci-bundle-budget.ts');
        expect(
            platformCheckCommands(
                {
                    CAXRI_VITEST_MAX_WORKERS: '2',
                    CAXRI_VITEST_PARTITION: 'optimized',
                    ESLINT_CONCURRENCY: 'off',
                },
                { includeNodePtyPreparation: false },
            ).some(({ id }) => id === 'node-pty-preparation'),
        ).toBe(false);
    });

    it('fails each independently receipted validation surface closed', () => {
        expect(isVerificationPassed(greenReceipt, 'checks', greenReceipt.provenance)).toBe(true);
        expect(isVerificationPassed(greenReceipt, 'parallel-safe', greenReceipt.provenance)).toBe(
            true,
        );
        expect(
            isVerificationPassed(greenReceipt, 'desktop-exclusive', greenReceipt.provenance),
        ).toBe(true);
        expect(isVerificationPassed(greenReceipt, 'e2e-auxiliary', greenReceipt.provenance)).toBe(
            true,
        );
        expect(
            isVerificationPassed({ ...greenReceipt, checks: 1 }, 'checks', greenReceipt.provenance),
        ).toBe(false);
        expect(
            isVerificationPassed(
                { ...greenReceipt, parallelSafe: null },
                'parallel-safe',
                greenReceipt.provenance,
            ),
        ).toBe(false);
        expect(
            isVerificationPassed(
                { ...greenReceipt, failureCensus: 1 },
                'e2e-auxiliary',
                greenReceipt.provenance,
            ),
        ).toBe(false);
        expect(
            isVerificationPassed(
                { ...greenReceipt, e2eSetup: null },
                'e2e-auxiliary',
                greenReceipt.provenance,
            ),
        ).toBe(false);
        expect(
            isVerificationPassed(greenReceipt, 'checks', {
                ...greenReceipt.provenance,
                runAttempt: '2',
            }),
        ).toBe(false);
        expect(() => parseConcurrentValidationReceipt({ checks: 0 })).toThrow(
            'Invalid concurrent validation receipt',
        );
    });

    it('derives immutable receipt provenance from the current Actions attempt', () => {
        expect(
            concurrentValidationProvenance({
                CAXRI_CHECKS_REVISION: 'b'.repeat(40),
                CAXRI_E2E_PARALLEL_WORKERS: '3',
                CAXRI_E2E_PROFILE: 'optimized',
                CAXRI_EXPECTED_HEAD: 'a'.repeat(40),
                GITHUB_RUN_ATTEMPT: '2',
                GITHUB_RUN_ID: '456',
            }),
        ).toEqual({
            checksRevision: 'b'.repeat(40),
            exactHead: 'a'.repeat(40),
            parallelWorkers: 3,
            profile: 'optimized',
            runAttempt: '2',
            runId: '456',
        });
    });

    it('derives the disposable checks checkout only from the owned E2E temp root', () => {
        expect(
            checksWorktreePath({
                CAXRI_RUNNER_OWNER: 'caxri-123-1-e2e',
                TMPDIR: '/private/tmp/caxri-123-1-e2e',
            }),
        ).toBe('/private/tmp/caxri-123-1-e2e/synthetic-merge-checks');
        expect(() =>
            checksWorktreePath({
                CAXRI_RUNNER_OWNER: 'unowned',
                TMPDIR: '/private/tmp/unowned',
            }),
        ).toThrow('Invalid E2E runner owner');
        expect(() =>
            checksWorktreePath({
                CAXRI_RUNNER_OWNER: 'caxri-123-1-e2e',
                TMPDIR: '/tmp/foreign-root',
            }),
        ).toThrow('does not match the owned short temporary path');
    });

    it('authenticates a missing synthetic merge fetch without persisting the job token', () => {
        const environment = authenticatedGitEnvironment({
            CAXRI_GITHUB_TOKEN: 'job-token',
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'existing.key',
            GIT_CONFIG_VALUE_0: 'existing-value',
        });

        expect(environment.CAXRI_GITHUB_TOKEN).toBeUndefined();
        expect(environment).toMatchObject({
            GIT_CONFIG_COUNT: '2',
            GIT_CONFIG_KEY_0: 'existing.key',
            GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
            GIT_CONFIG_VALUE_0: 'existing-value',
        });
        expect(environment.GIT_CONFIG_VALUE_1).toMatch(/^AUTHORIZATION: basic /u);
        expect(environment.GIT_CONFIG_VALUE_1).not.toContain('job-token');
    });

    it('verifies raw synthetic merge parents after a depth-one fetch marks the commit shallow', async () => {
        const fixtureRoot = await mkdtemp(join(tmpdir(), 'caxri-shallow-merge-'));
        const source = join(fixtureRoot, 'source');
        const shallow = join(fixtureRoot, 'shallow');
        const disposable = join(fixtureRoot, 'disposable');

        try {
            await execFileAsync('git', ['init', source]);
            await execFileAsync('git', ['config', 'user.name', 'Caxri CI'], { cwd: source });
            await execFileAsync('git', ['config', 'user.email', 'ci@caxri.test'], { cwd: source });
            await writeFile(join(source, 'fixture.txt'), 'base\n', 'utf8');
            await execFileAsync('git', ['add', 'fixture.txt'], { cwd: source });
            await execFileAsync('git', ['commit', '-m', 'base'], { cwd: source });
            const { stdout: baseOutput } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
                cwd: source,
            });
            const baseRevision = baseOutput.trim();
            await execFileAsync('git', ['branch', 'base-ref', baseRevision], { cwd: source });

            await execFileAsync('git', ['checkout', '-b', 'feature'], { cwd: source });
            await writeFile(join(source, 'fixture.txt'), 'feature\n', 'utf8');
            await execFileAsync('git', ['commit', '-am', 'feature'], { cwd: source });
            const { stdout: headOutput } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
                cwd: source,
            });
            const headRevision = headOutput.trim();

            await execFileAsync('git', ['checkout', '-b', 'integration', baseRevision], {
                cwd: source,
            });
            await execFileAsync('git', ['merge', '--no-ff', 'feature', '-m', 'synthetic merge'], {
                cwd: source,
            });
            const { stdout: mergeOutput } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
                cwd: source,
            });
            const mergeRevision = mergeOutput.trim();

            await execFileAsync('git', ['clone', '--depth=1', `file://${source}`, shallow]);
            const { stdout: traversalParents } = await execFileAsync(
                'git',
                ['show', '-s', '--format=%P', 'HEAD'],
                { cwd: shallow },
            );
            expect(traversalParents.trim()).toBe('');

            await expect(
                verifyRevisionProvenance(mergeRevision, baseRevision, headRevision, true, shallow),
            ).resolves.toEqual({ baseRevision });

            await writeFile(join(source, 'live-ref.txt'), 'advanced\n', 'utf8');
            await execFileAsync('git', ['add', 'live-ref.txt'], { cwd: source });
            await execFileAsync('git', ['commit', '-m', 'advance live merge ref'], { cwd: source });
            const { stdout: advancedMergeOutput } = await execFileAsync(
                'git',
                ['rev-parse', 'refs/heads/integration'],
                { cwd: source },
            );
            expect(advancedMergeOutput.trim()).not.toBe(mergeRevision);

            const checkoutProcesses = new ConcurrentValidationProcesses();
            await createFetchedCheckout(
                disposable,
                {
                    baseFetchReference: baseRevision,
                    expectedBaseRevision: baseRevision,
                    expectedRevision: mergeRevision,
                    fetchReference: mergeRevision,
                    headRevision,
                    isMergeRequired: true,
                    remoteUrl: `file://${source}`,
                },
                { ...process.env, CAXRI_GITHUB_TOKEN: 'test-token' },
                {
                    execFile: (command, arguments_, options) =>
                        checkoutProcesses.capture(command, arguments_, options),
                },
            );
            const { stdout: disposableHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
                cwd: disposable,
            });
            expect(disposableHead.trim()).toBe(mergeRevision);
            const { stdout: mergeBase } = await execFileAsync(
                'git',
                ['merge-base', baseRevision, 'HEAD'],
                { cwd: disposable },
            );
            expect(mergeBase.trim()).toBe(baseRevision);
            await expect(
                access(join(disposable, '.git', 'objects', 'info', 'alternates')),
            ).rejects.toThrow();
            await expect(
                execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: disposable }),
            ).rejects.toThrow();
        } finally {
            await rm(fixtureRoot, { recursive: true });
        }
    });
});
