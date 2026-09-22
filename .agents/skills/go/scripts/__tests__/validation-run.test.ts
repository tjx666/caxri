import { Buffer } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFile, mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { runStateCli } from '../state-cli';
import { createInitialState } from '../state-model';
import {
    prepareRunDirectory,
    readState,
    statePathForRunId,
    writeInitialState,
    writeState,
} from '../state-storage';
import { recordValidationChildPid, startValidation } from '../validation-gate';
import { runValidation } from '../validation-run';
import { inspectWorktreeIntegrity } from '../worktree-integrity';

const cleanupPaths: string[] = [];
const STATE_CLI_PATH = fileURLToPath(new URL('../state.ts', import.meta.url));
const VALIDATION_RUN_COMMAND = ['validation', 'run'].join('-');

afterEach(async () => {
    const paths = [...cleanupPaths];
    cleanupPaths.length = 0;
    await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
});

async function fixture() {
    const worktree = await mkdtemp(join(tmpdir(), 'caxri-validation-run-'));
    cleanupPaths.push(worktree);
    execFileSync('git', ['init', '-q'], { cwd: worktree });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: worktree });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: worktree });
    await writeFile(join(worktree, '.gitignore'), 'ignored/\n', 'utf8');
    await writeFile(join(worktree, 'source.ts'), 'export const value = 1;\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: worktree });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: worktree });
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: worktree,
        encoding: 'utf8',
    }).trim();
    const runId = `validation-run-${Date.now()}-${process.pid}-${cleanupPaths.length}`;
    const statePath = statePathForRunId(runId);
    cleanupPaths.push(dirname(statePath));
    await prepareRunDirectory(statePath);
    await writeInitialState(
        statePath,
        createInitialState({
            objective: 'Execute one durable validation',
            runId,
            worktree: {
                baseSha: headSha,
                createdAt: '2026-08-28T00:00:00.000Z',
                mainCheckoutPath: `${worktree}-main`,
                path: worktree,
            },
        }),
    );
    return { headSha, statePath, worktree };
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForProcessExit(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 40 && isProcessAlive(pid); attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- bounded observation of one fixture process
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(isProcessAlive(pid)).toBe(false);
}

describe('Go validation runner', () => {
    it('streams output before close and persists a complete exact-head receipt', async () => {
        const { headSha, statePath } = await fixture();
        let terminalOutput = '';
        let isComplete = false;
        const { promise: firstOutput, resolve: releaseFirstOutput } = Promise.withResolvers<void>();
        const run = (async () => {
            const exitCode = await runValidation(
                statePath,
                {
                    arguments: [
                        '-e',
                        String.raw`process.stdout.write('first\n'); setTimeout(() => process.stdout.write('second\n'), 500)`,
                    ],
                    executable: process.execPath,
                    expectedHeadSha: headSha,
                    kind: 'gates',
                    lineageId: 'streaming-success',
                    sessionId: 'fixture-session',
                },
                {
                    writeStdout: (chunk) => {
                        terminalOutput += chunk.toString();
                        if (terminalOutput.includes('first')) releaseFirstOutput();
                    },
                },
            );
            isComplete = true;
            return exitCode;
        })();

        await firstOutput;
        expect(isComplete).toBe(false);
        for (let attempt = 0; attempt < 20; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- waits for the short child-PID ledger transition
            if ((await readState(statePath)).validations[0]?.childPid) break;
            // eslint-disable-next-line no-await-in-loop -- bounded fixture synchronization
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await runStateCli([
            'note',
            '--state',
            statePath,
            '--kind',
            'workflow',
            '--text',
            '正式验证在子进程运行期间释放 ledger 状态锁。',
        ]);
        expect(isComplete).toBe(false);
        await expect(run).resolves.toBe(0);

        const state = await readState(statePath);
        const validation = state.validations[0];
        expect(validation.arguments).toHaveLength(0);
        expect(validation.argumentCount).toBe(2);
        expect(validation.commandDigest).toMatch(/^[0-9a-f]{64}$/u);
        expect(validation.durationMs).toBeTypeOf('number');
        expect(validation.logByteLength).toBeTypeOf('number');
        expect(validation.logSha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(validation).toMatchObject({
            executable: process.execPath,
            exitCode: 0,
            headSha,
            logIntegrityError: null,
            result: 'passed',
            termination: 'exit',
        });
        expect(terminalOutput).toBe('first\nsecond\n');
        const logAbsolutePath = join(dirname(statePath), validation.logPath);
        const log = await readFile(logAbsolutePath, 'utf8');
        expect(log).toContain('first\nsecond\n');
        expect(log).toContain('CAXRI_VALIDATION_RESULT');
        expect((await stat(logAbsolutePath)).mode & 0o777).toBe(0o600);
        expect(state.mutationLease).toBeNull();
    });

    it('preserves stdout, stderr, and the real non-zero exit code', async () => {
        const { statePath } = await fixture();
        const terminal = { stderr: '', stdout: '' };
        await expect(
            runValidation(
                statePath,
                {
                    arguments: [
                        '-e',
                        String.raw`process.stdout.write('out\n'); process.stderr.write('err\n'); process.exit(7)`,
                    ],
                    executable: process.execPath,
                    kind: 'fixture',
                    lineageId: 'non-zero',
                },
                {
                    writeStderr: (chunk) => (terminal.stderr += chunk.toString()),
                    writeStdout: (chunk) => (terminal.stdout += chunk.toString()),
                },
            ),
        ).resolves.toBe(7);

        const state = await readState(statePath);
        expect(state.validations[0]).toMatchObject({
            exitCode: 7,
            result: 'failed',
            signal: null,
            termination: 'exit',
        });
        const log = await readFile(join(dirname(statePath), state.validations[0].logPath), 'utf8');
        expect(terminal).toEqual({ stderr: 'err\n', stdout: 'out\n' });
        expect(log).toContain('out\n');
        expect(log).toContain('err\n');
        expect(state.mutationLease).toBeNull();
    });

    it('never persists secret-bearing validation arguments', async () => {
        const { statePath } = await fixture();
        const secret = `github_pat_${'a'.repeat(20)}`;
        await expect(
            runValidation(statePath, {
                arguments: ['-e', 'process.exit(0)', '--', '--token', secret],
                executable: process.execPath,
                kind: 'fixture',
                lineageId: 'secret-argument',
            }),
        ).resolves.toBe(0);

        const stateSource = await readFile(statePath, 'utf8');
        const state = await readState(statePath);
        const log = await readFile(join(dirname(statePath), state.validations[0].logPath), 'utf8');
        expect(stateSource).not.toContain(secret);
        expect(log).not.toContain(secret);
        expect(state.validations[0]).toMatchObject({ argumentCount: 5, arguments: [] });
    });

    it('redacts a secret-bearing executable from launch failures', async () => {
        const { statePath } = await fixture();
        const secret = `github_pat_${'b'.repeat(20)}`;
        await expect(
            runValidation(statePath, {
                arguments: [],
                executable: `/tmp/${secret}`,
                kind: 'fixture',
                lineageId: 'secret-executable',
            }),
        ).resolves.toBe(1);

        const stateSource = await readFile(statePath, 'utf8');
        const state = await readState(statePath);
        const log = await readFile(join(dirname(statePath), state.validations[0].logPath), 'utf8');
        expect(stateSource).not.toContain(secret);
        expect(log).not.toContain(secret);
        expect(log).toContain('[REDACTED]');
    });

    it('terminates output floods with a complete bounded failure receipt', async () => {
        const { statePath } = await fixture();
        await expect(
            runValidation(
                statePath,
                {
                    arguments: [
                        '-e',
                        "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)",
                    ],
                    executable: process.execPath,
                    kind: 'fixture',
                    lineageId: 'output-limit',
                },
                { validationLogOptions: { highWatermarkBytes: 16, maxOutputBytes: 64 } },
            ),
        ).resolves.toBe(1);

        const state = await readState(statePath);
        const validation = state.validations[0];
        const log = await readFile(join(dirname(statePath), validation.logPath), 'utf8');
        expect(validation).toMatchObject({ result: 'failed', termination: 'output_limit' });
        expect(validation.logByteLength).toBeTypeOf('number');
        expect(validation.logSha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(log).toContain('CAXRI_VALIDATION_TRUNCATED');
        expect(log).toContain('CAXRI_VALIDATION_RESULT');
        expect(Buffer.byteLength(log)).toBeLessThan(4096);
        expect(state.mutationLease).toBeNull();
    });

    it('times out a hung validation and releases its lease', async () => {
        const { statePath } = await fixture();
        await expect(
            runValidation(
                statePath,
                {
                    arguments: ['-e', 'setInterval(() => {}, 1000)'],
                    executable: process.execPath,
                    kind: 'fixture',
                    lineageId: 'timeout',
                },
                { timeoutMs: 50 },
            ),
        ).resolves.toBe(1);

        const state = await readState(statePath);
        expect(state.validations[0]).toMatchObject({ result: 'failed', termination: 'timeout' });
        expect(state.mutationLease).toBeNull();
    });

    it('passes only the allowlisted build environment to the logged command', async () => {
        const { statePath } = await fixture();
        let terminalOutput = '';
        await expect(
            runValidation(
                statePath,
                {
                    arguments: [
                        '-e',
                        'process.stdout.write(JSON.stringify({ authorized: process.env.CAXRI_FULL_SUITE_AUTHORIZED, github: process.env.GH_TOKEN, internal: process.env.CAXRI_GITHUB_TOKEN, path: process.env.PATH, proxy: process.env.HTTPS_PROXY, workers: process.env.CAXRI_VITEST_MAX_WORKERS }))',
                    ],
                    executable: process.execPath,
                    kind: 'fixture',
                    lineageId: 'filtered-environment',
                },
                {
                    environment: {
                        CAXRI_FULL_SUITE_AUTHORIZED: '1',
                        CAXRI_GITHUB_TOKEN: 'private-internal-token',
                        CAXRI_VITEST_MAX_WORKERS: '2',
                        GH_TOKEN: 'private-github-token',
                        HTTPS_PROXY: 'https://private-proxy-credential@example.test',
                        PATH: '/safe/bin',
                    },
                    writeStdout: (chunk) => (terminalOutput += chunk.toString()),
                },
            ),
        ).resolves.toBe(0);

        expect(JSON.parse(terminalOutput)).toEqual({
            authorized: '1',
            path: '/safe/bin',
            workers: '2',
        });
        const log = await readFile(
            join(dirname(statePath), 'validation/validation-001.log'),
            'utf8',
        );
        expect(log).not.toContain('private-');
    });

    it('records launch errors without leaving a pending validation lease', async () => {
        const { statePath } = await fixture();
        const executable = `/missing/caxri-validation-${Date.now()}-${process.pid}`;

        await expect(
            runValidation(statePath, {
                arguments: [],
                executable,
                kind: 'fixture',
                lineageId: 'launch-error',
            }),
        ).resolves.toBe(1);

        const state = await readState(statePath);
        expect(state.validations[0]).toMatchObject({
            executable,
            exitCode: null,
            result: 'failed',
            termination: 'spawn_error',
        });
        expect(state.mutationLease).toBeNull();
    });

    it('records a child signal separately from an exit code', async () => {
        const { statePath } = await fixture();

        await expect(
            runValidation(statePath, {
                arguments: ['-e', "process.kill(process.pid, 'SIGTERM')"],
                executable: process.execPath,
                kind: 'fixture',
                lineageId: 'child-signal',
            }),
        ).resolves.toBe(1);

        const state = await readState(statePath);
        expect(state.validations[0]).toMatchObject({
            exitCode: null,
            result: 'failed',
            signal: 'SIGTERM',
            termination: 'signal',
        });
        expect(state.mutationLease).toBeNull();
    });

    it('forwards caller interruption to the complete child process group', async () => {
        const { statePath } = await fixture();
        // eslint-disable-next-line unicorn/prefer-event-target -- mirrors Node process signal events used by the runner
        const signalSource = new EventEmitter();
        let grandchildPid: number | undefined;
        const { promise: grandchildStarted, resolve: releaseGrandchild } =
            Promise.withResolvers<void>();
        const script = [
            "const { spawn } = require('node:child_process')",
            "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
            'process.stdout.write(`grandchild:${grandchild.pid}\\n`)',
            'setInterval(() => {}, 1000)',
        ].join('; ');
        const run = runValidation(
            statePath,
            {
                arguments: ['-e', script],
                executable: process.execPath,
                kind: 'fixture',
                lineageId: 'caller-interrupt',
            },
            {
                signalSource,
                writeStdout: (chunk) => {
                    const match = /grandchild:(\d+)/u.exec(chunk.toString());
                    if (!match) return;
                    grandchildPid = Number(match[1]);
                    releaseGrandchild();
                },
            },
        );

        await grandchildStarted;
        signalSource.emit('SIGINT');
        await expect(run).resolves.toBe(130);

        const state = await readState(statePath);
        const validation = state.validations[0];
        expect(validation).toMatchObject({
            exitCode: null,
            result: 'failed',
            signal: 'SIGINT',
            termination: 'caller_interrupt',
        });
        expect(validation.childPid).not.toBeNull();
        await waitForProcessExit(validation.childPid!);
        await waitForProcessExit(grandchildPid!);
        expect(state.mutationLease).toBeNull();
    });

    it('recovers a real SIGKILLed runner and its surviving process group', async () => {
        const { statePath } = await fixture();
        const stubborn = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
        const script = [
            "const { spawn } = require('node:child_process')",
            `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(stubborn)}], { stdio: 'ignore' })`,
            "process.on('SIGTERM', () => {})",
            'process.stdout.write(`leader:${process.pid} grandchild:${grandchild.pid}\\n`)',
            'setInterval(() => {}, 1000)',
        ].join('; ');
        const runner = spawn(
            'bun',
            [
                STATE_CLI_PATH,
                VALIDATION_RUN_COMMAND,
                '--state',
                statePath,
                '--kind',
                'fixture',
                '--lineage-id',
                'recovered-runner',
                '--',
                process.execPath,
                '-e',
                script,
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        const runnerPid = runner.pid;
        if (!runnerPid) throw new Error('Validation runner fixture did not start');
        const {
            promise: descendantsStarted,
            reject: rejectDescendants,
            resolve: releaseDescendants,
        } = Promise.withResolvers<{ grandchildPid: number; leaderPid: number }>();
        let isDescendantsWereStarted = false;
        let runnerStderr = '';
        runner.stdout.on('data', (chunk: Buffer) => {
            const match = /leader:(\d+) grandchild:(\d+)/u.exec(chunk.toString());
            if (match) {
                isDescendantsWereStarted = true;
                releaseDescendants({
                    grandchildPid: Number(match[2]),
                    leaderPid: Number(match[1]),
                });
            }
        });
        runner.stderr.on('data', (chunk: Buffer) => (runnerStderr += chunk.toString()));
        const runnerClose = new Promise<void>((resolve, reject) => {
            runner.once('error', reject);
            runner.once('close', (code, signal) => {
                if (!isDescendantsWereStarted) {
                    rejectDescendants(
                        new Error(
                            `Runner closed before descendants started: code=${String(code)} signal=${String(signal)} stderr=${runnerStderr}`,
                        ),
                    );
                }
                resolve();
            });
        });
        const descendants = await descendantsStarted;
        let recordedGroupPid: number | null = null;
        for (let attempt = 0; recordedGroupPid === null && attempt < 40; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- waits for the real runner's short PID receipt
            recordedGroupPid = (await readState(statePath)).validations[0]?.childPid ?? null;
            // eslint-disable-next-line no-await-in-loop -- bounded fixture synchronization
            if (recordedGroupPid === null) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(recordedGroupPid).not.toBeNull();
        process.kill(runnerPid, 'SIGKILL');
        await runnerClose;

        await expect(
            runValidation(statePath, {
                arguments: ['-e', String.raw`process.stdout.write('recovered\n')`],
                executable: process.execPath,
                kind: 'fixture',
                lineageId: 'recovered-runner',
            }),
        ).resolves.toBe(0);

        const state = await readState(statePath);
        expect(state.validations).toHaveLength(2);
        expect(state.validations[0].logError).toContain('before writing the completion footer');
        expect(state.validations[0]).toMatchObject({
            attempt: 1,
            result: 'failed',
            termination: 'runner_lost',
        });
        expect(state.validations[1]).toMatchObject({
            attempt: 1,
            result: 'passed',
            termination: 'exit',
        });
        await waitForProcessExit(recordedGroupPid!);
        await waitForProcessExit(descendants.leaderPid);
        await waitForProcessExit(descendants.grandchildPid);
        expect(state.mutationLease).toBeNull();
    });

    it('releases an abandoned receipt without signaling a recycled process group', async () => {
        const { headSha, statePath, worktree } = await fixture();
        const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            detached: process.platform !== 'win32',
            stdio: 'ignore',
        });
        const decoyPid = decoy.pid;
        if (!decoyPid) throw new Error('Decoy process fixture did not start');
        await new Promise<void>((resolve, reject) => {
            decoy.once('error', reject);
            decoy.once('spawn', resolve);
        });
        try {
            const state = await readState(statePath);
            const integrity = await inspectWorktreeIntegrity(worktree);
            const lost = startValidation(state, {
                argumentCount: 0,
                artifactVersion: 1,
                command: 'lost validation',
                commandDigest: 'a'.repeat(64),
                executable: process.execPath,
                headSha,
                kind: 'fixture',
                lineageId: 'pid-reuse',
                runnerIdentity: 'b'.repeat(64),
                runnerPid: 2_147_483_647,
                sourceFingerprint: integrity.sourceFingerprint,
            });
            recordValidationChildPid(state, lost.id, lost.runnerPid!, decoyPid, 'c'.repeat(64));
            await writeState(statePath, state);

            await expect(
                runValidation(statePath, {
                    arguments: ['-e', String.raw`process.stdout.write('safe recovery\n')`],
                    executable: process.execPath,
                    kind: 'fixture',
                    lineageId: 'pid-reuse',
                }),
            ).resolves.toBe(0);

            const recovered = await readState(statePath);
            expect(recovered.validations[0]).toMatchObject({
                result: 'failed',
                termination: 'runner_lost',
            });
            expect(recovered.validations[0].logError).toContain('Refusing to signal unowned');
            expect(isProcessAlive(decoyPid)).toBe(true);
            expect(recovered.mutationLease).toBeNull();
        } finally {
            if (isProcessAlive(decoyPid)) decoy.kill('SIGTERM');
            await waitForProcessExit(decoyPid);
        }
    });

    it('keeps a live pending runner when its identity probe is unavailable', async () => {
        const { headSha, statePath, worktree } = await fixture();
        const state = await readState(statePath);
        const integrity = await inspectWorktreeIntegrity(worktree);
        const pending = startValidation(state, {
            argumentCount: 0,
            artifactVersion: 1,
            command: 'pending validation',
            commandDigest: 'd'.repeat(64),
            executable: process.execPath,
            headSha,
            kind: 'fixture',
            lineageId: 'runner-probe-failure',
            runnerIdentity: 'e'.repeat(64),
            runnerPid: process.pid,
            sourceFingerprint: integrity.sourceFingerprint,
        });
        await writeState(statePath, state);

        await expect(
            runValidation(
                statePath,
                {
                    arguments: [],
                    executable: process.execPath,
                    kind: 'fixture',
                    lineageId: 'runner-probe-failure',
                },
                {
                    getProcessIdentity: async (pid) => {
                        await Promise.resolve();
                        return ['identity'].at(pid);
                    },
                },
            ),
        ).rejects.toThrow('identity could not be verified');

        const preserved = await readState(statePath);
        expect(preserved.validations[0]).toMatchObject({ id: pending.id, result: 'pending' });
        expect(preserved.mutationLease).toMatchObject({
            holderId: pending.id,
            kind: 'validation',
        });
    });

    it.each(['deleted', 'digest-changed', 'truncated', 'tampered'] as const)(
        'invalidates a passed receipt when its log is %s',
        async (mutation) => {
            const { statePath } = await fixture();
            await runValidation(statePath, {
                arguments: ['-e', String.raw`process.stdout.write('artifact\n')`],
                executable: process.execPath,
                kind: 'fixture',
                lineageId: `artifact-${mutation}`,
            });
            const passed = await readState(statePath);
            const logPath = join(dirname(statePath), passed.validations[0].logPath);
            switch (mutation) {
                case 'deleted': {
                    await rm(logPath);
                    break;
                }
                case 'digest-changed': {
                    const original = await readFile(logPath);
                    original[0] ^= 1;
                    await writeFile(logPath, original);

                    break;
                }
                case 'truncated': {
                    await truncate(logPath, 5);
                    break;
                }
                default:
                    await appendFile(logPath, 'tampered\n', 'utf8');
            }

            const invalid = await readState(statePath);
            expect(invalid.validations[0].result).toBe('failed');
            expect(invalid.validations[0].logIntegrityError).toBeTruthy();
            await expect(runStateCli(['validate', '--state', statePath])).rejects.toThrow(
                'artifact is invalid',
            );
        },
    );
});
