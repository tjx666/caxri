import type { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type { GoState } from './state-model';
import { addEvent } from './state-model';
import { readState, runDirectoryForStatePath, withStateLock, writeState } from './state-storage';
import type { ValidationLogReceipt, ValidationLogWriter } from './validation-artifact';
import { createValidationLog, inspectValidationLog } from './validation-artifact';
import type { ValidationKind, ValidationRecord, ValidationTermination } from './validation-gate';
import { completeValidation, recordValidationChildPid, startValidation } from './validation-gate';
import { assertCleanValidationStart, inspectWorktreeIntegrity } from './worktree-integrity';

const PROCESS_GROUP_KILL_GRACE_MS = 2_000;
const STATE_LOCK_RETRY_LIMIT = 100;
const VALIDATION_CHILD_PATH = fileURLToPath(new URL('validation-child.ts', import.meta.url));

const VALIDATION_ENVIRONMENT_KEYS = [
    'BUN_INSTALL',
    'CAXRI_REACT_DOCTOR_BASE',
    'CAXRI_VITEST_MAX_WORKERS',
    'CAXRI_VITEST_PARTITION',
    'CI',
    'COLORTERM',
    'ESLINT_CONCURRENCY',
    'FORCE_COLOR',
    'HOME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'LOGNAME',
    'NODE_EXTRA_CA_CERTS',
    'NO_COLOR',
    'PATH',
    'PNPM_HOME',
    'SHELL',
    'SSL_CERT_DIR',
    'SSL_CERT_FILE',
    'TEMP',
    'TERM',
    'TMP',
    'TMPDIR',
    'USER',
    'VITEST_MAX_WORKERS',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
] as const;

interface ValidationChildMessage {
    code?: number | null;
    message?: string;
    signal?: NodeJS.Signals | null;
    type: 'result' | 'spawn_error';
}

interface SignalSource {
    off(event: NodeJS.Signals, listener: () => void): unknown;
    on(event: NodeJS.Signals, listener: () => void): unknown;
}

interface RunValidationDependencies {
    environment?: NodeJS.ProcessEnv;
    runnerPid?: number;
    signalSource?: SignalSource;
    writeStderr?: (chunk: Uint8Array) => void;
    writeStdout?: (chunk: Uint8Array) => void;
}

/**
 * Formal validation inherits only deterministic toolchain context. In particular, repository and GitHub credentials are
 * never copied into commands whose stdout and stderr become durable logs.
 */
function safeValidationEnvironment(
    source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const key of VALIDATION_ENVIRONMENT_KEYS) {
        const value = source[key];
        if (value !== undefined) environment[key] = value;
    }
    return environment;
}

export interface RunValidationInput {
    arguments: string[];
    executable: string;
    expectedHeadSha?: string;
    kind: ValidationKind;
    lineageId: string;
    sessionId?: string;
}

interface ProcessOutcome {
    durationMs: number;
    exitCode: number | null;
    logError: string | null;
    logReceipt: ValidationLogReceipt | null;
    signal: NodeJS.Signals | null;
    termination: ValidationTermination;
}

interface PendingSnapshot {
    childPid: number | null;
    id: string;
    logPath: string;
    runnerPid: number | null;
    startedAt: string;
}

function errorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    return typeof error.code === 'string' ? error.code : undefined;
}

function displayArgument(argument: string): string {
    return /^[\w./:=@+-]+$/u.test(argument) ? argument : JSON.stringify(argument);
}

function formatValidationCommand(executable: string, arguments_: string[]): string {
    return [executable, ...arguments_].map(displayArgument).join(' ');
}

function writeTerminal(writer: (chunk: Uint8Array) => void, chunk: Uint8Array): void {
    try {
        writer(chunk);
    } catch {
        // Terminal mirroring is best-effort; the private durable log remains authoritative.
    }
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        return !(
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ESRCH'
        );
    }
}

function isProcessGroupAlive(pid: number): boolean {
    if (process.platform === 'win32') return isProcessAlive(pid);
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error: unknown) {
        return !(
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ESRCH'
        );
    }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
    try {
        if (process.platform === 'win32') process.kill(pid, signal);
        else process.kill(-pid, signal);
    } catch (error: unknown) {
        if (
            typeof error !== 'object' ||
            error === null ||
            !('code' in error) ||
            error.code !== 'ESRCH'
        ) {
            throw error;
        }
    }
}

async function hasProcessGroupExited(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (isProcessGroupAlive(pid) && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- bounded wait observes one owned process group
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !isProcessGroupAlive(pid);
}

async function terminateProcessGroup(pid: number): Promise<void> {
    if (!isProcessGroupAlive(pid)) return;
    signalProcessGroup(pid, 'SIGTERM');
    if (await hasProcessGroupExited(pid, PROCESS_GROUP_KILL_GRACE_MS)) return;
    signalProcessGroup(pid, 'SIGKILL');
    if (!(await hasProcessGroupExited(pid, PROCESS_GROUP_KILL_GRACE_MS))) {
        throw new Error(`Validation child process group ${pid} did not exit`);
    }
}

async function updateState<T>(
    statePath: string,
    action: (state: GoState) => Promise<T> | T,
): Promise<T> {
    for (let attempt = 1; attempt <= STATE_LOCK_RETRY_LIMIT; attempt += 1) {
        try {
            // eslint-disable-next-line no-await-in-loop -- bounded retry lets short bookkeeping locks coexist with a long validation
            return await withStateLock(statePath, async () => {
                const state = await readState(statePath);
                const result = await action(state);
                await writeState(statePath, state);
                return result;
            });
        } catch (error: unknown) {
            const isTransientLock =
                error instanceof Error &&
                error.message === 'Go state is already locked by another writer';
            if (!isTransientLock || attempt === STATE_LOCK_RETRY_LIMIT) throw error;
            // eslint-disable-next-line no-await-in-loop -- the existing owner must release its short state transition
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
    throw new Error('Validation state lock retry budget exhausted');
}

async function recoverAbandonedValidation(statePath: string): Promise<void> {
    const pending = await withStateLock(statePath, async (): Promise<PendingSnapshot | null> => {
        const state = await readState(statePath);
        const record = state.validations.find(({ result }) => result === 'pending');
        if (!record) return null;
        if (record.artifactVersion !== 1 || record.runnerPid === null) {
            throw new Error(
                `Validation ${record.id} predates validation-run and cannot be recovered automatically`,
            );
        }
        if (isProcessAlive(record.runnerPid)) {
            throw new Error(`Validation ${record.id} runner ${record.runnerPid} is still alive`);
        }
        return {
            childPid: record.childPid,
            id: record.id,
            logPath: record.logPath,
            runnerPid: record.runnerPid,
            startedAt: record.startedAt,
        };
    });
    if (!pending) return;
    if (pending.childPid !== null) await terminateProcessGroup(pending.childPid);

    let logReceipt: ValidationLogReceipt | null = null;
    let logError = 'Validation runner ended before writing the completion footer';
    try {
        logReceipt = await inspectValidationLog(
            runDirectoryForStatePath(statePath),
            pending.logPath,
        );
    } catch {
        logError = 'Validation runner ended before creating a complete log';
    }
    await updateState(statePath, async (state) => {
        const record = state.validations.find(({ id }) => id === pending.id);
        if (record?.result !== 'pending' || record.runnerPid !== pending.runnerPid) {
            throw new Error(`Validation ${pending.id} changed during recovery`);
        }
        if (!state.worktree) throw new Error('Validation requires a recorded Go worktree');
        const integrity = await inspectWorktreeIntegrity(state.worktree.path);
        const recovered = completeValidation(state, {
            clean: integrity.clean,
            durationMs: Math.max(0, Date.now() - Date.parse(pending.startedAt)),
            exitCode: null,
            headSha: integrity.headSha,
            id: pending.id,
            logByteLength: logReceipt?.byteLength ?? null,
            logError,
            logMetadata: logReceipt?.metadata ?? null,
            logSha256: logReceipt?.sha256 ?? null,
            signal: null,
            sourceFingerprint: integrity.sourceFingerprint,
            termination: 'runner_lost',
        });
        addEvent(state, 'validation', `${recovered.id} -> failed (runner_lost)`);
    });
}

async function recordChildProcess(
    statePath: string,
    validationId: string,
    runnerPid: number,
    childPid: number,
): Promise<void> {
    await updateState(statePath, (state) => {
        recordValidationChildPid(state, validationId, runnerPid, childPid);
    });
}

function processFooter(outcome: Omit<ProcessOutcome, 'durationMs' | 'logError' | 'logReceipt'>) {
    return `\nCAXRI_VALIDATION_RESULT ${JSON.stringify(outcome)}\n`;
}

async function executeLoggedCommand(
    input: RunValidationInput,
    worktreePath: string,
    log: ValidationLogWriter,
    onSpawn: (pid: number) => Promise<void>,
    dependencies: RunValidationDependencies,
): Promise<ProcessOutcome> {
    const started = Date.now();
    const signalSource = dependencies.signalSource ?? process;
    const writeStdout = dependencies.writeStdout ?? ((chunk) => process.stdout.write(chunk));
    const writeStderr = dependencies.writeStderr ?? ((chunk) => process.stderr.write(chunk));
    log.write(
        `CAXRI_VALIDATION_START ${JSON.stringify({ arguments: input.arguments, executable: input.executable })}\n`,
    );

    const lifecycle: {
        childPid: number | null;
        commandResult: { code: number | null; signal: NodeJS.Signals | null } | null;
        forceKillTimer: NodeJS.Timeout | null;
        interruptedSignal: NodeJS.Signals | null;
        isLaunchError: boolean;
        isRunnerError: boolean;
    } = {
        childPid: null,
        commandResult: null,
        forceKillTimer: null,
        interruptedSignal: null,
        isLaunchError: false,
        isRunnerError: false,
    };
    let childRegistration = Promise.resolve();

    const forwardSignal = (signal: NodeJS.Signals): void => {
        lifecycle.interruptedSignal ??= signal;
        const childPid = lifecycle.childPid;
        if (!childPid) return;
        signalProcessGroup(childPid, signal);
        lifecycle.forceKillTimer ??= setTimeout(
            () => signalProcessGroup(childPid, 'SIGKILL'),
            PROCESS_GROUP_KILL_GRACE_MS,
        );
        lifecycle.forceKillTimer.unref();
    };
    const onInterrupt = () => forwardSignal('SIGINT');
    const onTerminate = () => forwardSignal('SIGTERM');
    signalSource.on('SIGINT', onInterrupt);
    signalSource.on('SIGTERM', onTerminate);

    const close = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
            try {
                const spawned = spawn(process.execPath, [VALIDATION_CHILD_PATH], {
                    cwd: worktreePath,
                    detached: process.platform !== 'win32',
                    env: safeValidationEnvironment(dependencies.environment),
                    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
                });
                spawned.stdout.on('data', (chunk: Buffer) => {
                    writeTerminal(writeStdout, chunk);
                    log.write(chunk);
                });
                spawned.stderr.on('data', (chunk: Buffer) => {
                    writeTerminal(writeStderr, chunk);
                    log.write(chunk);
                });
                spawned.stdin.on('error', (error) => {
                    if (errorCode(error) === 'EPIPE') return;
                    lifecycle.isRunnerError = true;
                    log.write(`CAXRI_VALIDATION_RUNNER_ERROR ${error.message}\n`);
                });
                const control = spawned.stdio[3];
                if (!control || !('on' in control)) {
                    throw new Error('Validation child control pipe was not created');
                }
                let controlBuffer = '';
                control.on('data', (chunk: Buffer) => {
                    controlBuffer += chunk.toString();
                    for (;;) {
                        const newline = controlBuffer.indexOf('\n');
                        if (newline === -1) break;
                        const source = controlBuffer.slice(0, newline);
                        controlBuffer = controlBuffer.slice(newline + 1);
                        try {
                            const message = JSON.parse(source) as ValidationChildMessage;
                            if (message.type === 'spawn_error') {
                                lifecycle.isLaunchError = true;
                                log.write(
                                    `CAXRI_VALIDATION_LAUNCH_ERROR ${message.message ?? 'Unknown launch error'}\n`,
                                );
                            } else {
                                lifecycle.commandResult = {
                                    code: message.code ?? null,
                                    signal: message.signal ?? null,
                                };
                            }
                        } catch (error: unknown) {
                            lifecycle.isRunnerError = true;
                            log.write(
                                `CAXRI_VALIDATION_RUNNER_ERROR Invalid child control message: ${error instanceof Error ? error.message : String(error)}\n`,
                            );
                        }
                    }
                });
                spawned.once('spawn', () => {
                    const childPid = spawned.pid;
                    if (!childPid) return;
                    lifecycle.childPid = childPid;
                    childRegistration = (async () => {
                        try {
                            await onSpawn(childPid);
                            if (lifecycle.interruptedSignal) {
                                forwardSignal(lifecycle.interruptedSignal);
                                return;
                            }
                            spawned.stdin.write(
                                `${JSON.stringify({
                                    arguments: input.arguments,
                                    environment: safeValidationEnvironment(
                                        dependencies.environment,
                                    ),
                                    executable: input.executable,
                                    worktreePath,
                                })}\n`,
                            );
                        } catch (error: unknown) {
                            lifecycle.isRunnerError = true;
                            log.write(
                                `CAXRI_VALIDATION_RUNNER_ERROR ${error instanceof Error ? error.message : String(error)}\n`,
                            );
                            try {
                                await terminateProcessGroup(childPid);
                            } catch (terminationError: unknown) {
                                log.write(
                                    `CAXRI_VALIDATION_RUNNER_ERROR ${terminationError instanceof Error ? terminationError.message : String(terminationError)}\n`,
                                );
                            }
                        }
                    })();
                });
                spawned.once('error', (error) => {
                    lifecycle.isRunnerError = true;
                    log.write(`CAXRI_VALIDATION_RUNNER_ERROR ${error.message}\n`);
                });
                spawned.once('close', (code, signal) => resolve({ code, signal }));
            } catch (error: unknown) {
                lifecycle.isLaunchError = true;
                log.write(
                    `CAXRI_VALIDATION_LAUNCH_ERROR ${error instanceof Error ? error.message : String(error)}\n`,
                );
                resolve({ code: null, signal: null });
                return;
            }
        },
    );

    signalSource.off('SIGINT', onInterrupt);
    signalSource.off('SIGTERM', onTerminate);
    if (lifecycle.forceKillTimer) clearTimeout(lifecycle.forceKillTimer);
    await childRegistration;
    const childPid = lifecycle.childPid;
    if (childPid && isProcessGroupAlive(childPid)) {
        try {
            await terminateProcessGroup(childPid);
        } catch (error: unknown) {
            lifecycle.isRunnerError = true;
            log.write(
                `CAXRI_VALIDATION_RUNNER_ERROR ${error instanceof Error ? error.message : String(error)}\n`,
            );
        }
    }
    if (!lifecycle.commandResult && !lifecycle.interruptedSignal && !lifecycle.isLaunchError) {
        lifecycle.isRunnerError = true;
        log.write(
            `CAXRI_VALIDATION_RUNNER_ERROR Supervisor exited without a command result (${String(close.code)}, ${String(close.signal)})\n`,
        );
    }
    const termination: ValidationTermination = lifecycle.interruptedSignal
        ? 'caller_interrupt'
        : lifecycle.isRunnerError
          ? 'runner_error'
          : lifecycle.isLaunchError
            ? 'spawn_error'
            : lifecycle.commandResult?.signal
              ? 'signal'
              : 'exit';
    const signal = lifecycle.interruptedSignal ?? lifecycle.commandResult?.signal ?? null;
    const exitCode = termination === 'exit' ? (lifecycle.commandResult?.code ?? null) : null;
    log.write(processFooter({ exitCode, signal, termination }));

    let logReceipt: ValidationLogReceipt | null = null;
    let logError: string | null = null;
    try {
        logReceipt = await log.finish();
    } catch (error: unknown) {
        logError = error instanceof Error ? error.message : 'Validation log could not be finalized';
    }
    return {
        durationMs: Math.max(0, Date.now() - started),
        exitCode,
        logError,
        logReceipt,
        signal,
        termination,
    };
}

function processExitStatus(outcome: ProcessOutcome): number {
    if (outcome.termination === 'exit') {
        const exitCode = outcome.exitCode ?? 1;
        return exitCode >= 0 && exitCode <= 255 ? exitCode : 1;
    }
    if (outcome.termination === 'caller_interrupt' && outcome.signal) {
        return 128 + osConstants.signals[outcome.signal];
    }
    return 1;
}

/**
 * Owns one formal validation from pending receipt through process-group completion and exact-head finalization. State
 * locks cover only short ledger transitions; the child process runs entirely outside the writer lock.
 */
export async function runValidation(
    statePath: string,
    input: RunValidationInput,
    dependencies: RunValidationDependencies = {},
): Promise<number> {
    if (!input.executable.trim()) throw new Error('Validation executable is required');
    await recoverAbandonedValidation(statePath);
    const runnerPid = dependencies.runnerPid ?? process.pid;
    const started = await updateState(statePath, async (state) => {
        if (!state.worktree) throw new Error('Validation requires a recorded Go worktree');
        const integrity = await inspectWorktreeIntegrity(state.worktree.path);
        assertCleanValidationStart(integrity, input.expectedHeadSha);
        const validation = startValidation(state, {
            arguments: input.arguments,
            artifactVersion: 1,
            command: formatValidationCommand(input.executable, input.arguments),
            executable: input.executable,
            headSha: integrity.headSha,
            kind: input.kind,
            lineageId: input.lineageId,
            runnerPid,
            sessionId: input.sessionId,
            sourceFingerprint: integrity.sourceFingerprint,
        });
        addEvent(state, 'validation', `${validation.id} -> pending`);
        return {
            id: validation.id,
            logPath: validation.logPath,
            worktreePath: state.worktree.path,
        };
    });

    let log: ValidationLogWriter;
    try {
        log = await createValidationLog(runDirectoryForStatePath(statePath), started.logPath);
    } catch (error: unknown) {
        const outcome: ProcessOutcome = {
            durationMs: 0,
            exitCode: null,
            logError:
                error instanceof Error ? error.message : 'Validation log could not be created',
            logReceipt: null,
            signal: null,
            termination: 'runner_error',
        };
        await finalizeValidation(statePath, started.id, outcome);
        return 1;
    }

    const outcome = await executeLoggedCommand(
        input,
        started.worktreePath,
        log,
        (childPid) => recordChildProcess(statePath, started.id, runnerPid, childPid),
        dependencies,
    );
    await finalizeValidation(statePath, started.id, outcome);
    return processExitStatus(outcome);
}

async function finalizeValidation(
    statePath: string,
    validationId: string,
    outcome: ProcessOutcome,
): Promise<ValidationRecord> {
    return updateState(statePath, async (state) => {
        if (!state.worktree) throw new Error('Validation requires a recorded Go worktree');
        const integrity = await inspectWorktreeIntegrity(state.worktree.path);
        const record = completeValidation(state, {
            clean: integrity.clean,
            durationMs: outcome.durationMs,
            exitCode: outcome.exitCode,
            headSha: integrity.headSha,
            id: validationId,
            logByteLength: outcome.logReceipt?.byteLength ?? null,
            logError: outcome.logError,
            logMetadata: outcome.logReceipt?.metadata ?? null,
            logSha256: outcome.logReceipt?.sha256 ?? null,
            signal: outcome.signal,
            sourceFingerprint: integrity.sourceFingerprint,
            termination: outcome.termination,
        });
        addEvent(state, 'validation', `${record.id} -> ${record.result} (${record.termination})`);
        return record;
    });
}
