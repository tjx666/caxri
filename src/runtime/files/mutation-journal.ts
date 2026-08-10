import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import { CaxriError, errorMessage, isCaxriError } from '../../shared/ipc/errors';
import { fileMutationOperationSchema } from '../../shared/ipc/domain';
import type { RuntimeEvent } from '../../shared/ipc/events';
import type { StructuredLogger } from '../../shared/node/logger';
import type { FileMutationOperation, MovedFileEntry, MutableFileEntry } from '../../shared/types';

type FileMutationResult = MutableFileEntry | MovedFileEntry;
type FileMutationExpectedResult = NonNullable<FileMutationOperation['expectedResult']>;
type StageMutation = (expectedResult: FileMutationExpectedResult) => Promise<void>;

export interface FileMutationJournalOptions {
    /** Test seam for shortening in-process finalization retries. */
    completionRetryBaseMs?: number;
    maximumActivePerSession?: number;
    now?: () => number;
    preStageTimeoutMs?: number;
    /** Test seam for transient journal persistence failures. */
    writeJournal?: (path: string, source: string) => Promise<void>;
}

interface PendingCompletion {
    attempt: number;
    result: FileMutationResult;
    timer?: ReturnType<typeof setTimeout>;
}

const MAXIMUM_RETAINED_OPERATIONS = 256;
const DEFAULT_MAXIMUM_ACTIVE_PER_SESSION = 8;
const DEFAULT_PRE_STAGE_TIMEOUT_MS = 15_000;
const DEFAULT_COMPLETION_RETRY_BASE_MS = 250;
const MAXIMUM_COMPLETION_RETRY_MS = 30_000;
const finalPhases = new Set<FileMutationOperation['phase']>(['completed', 'failed', 'canceled']);

function cloneOperation(operation: FileMutationOperation): FileMutationOperation {
    return structuredClone(operation);
}

function operationFailure(error: unknown): { code: string; message: string } {
    return {
        code:
            (isCaxriError(error) ? error.code : undefined) ??
            (error as NodeJS.ErrnoException).code ??
            'IO',
        message: errorMessage(error, 'File operation failed'),
    };
}

async function atomicWrite(path: string, source: string): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        const file = await open(temporary, 'wx', 0o600);
        try {
            await file.writeFile(source, 'utf8');
            await file.sync();
        } finally {
            await file.close();
        }
        await rename(temporary, path);
        const directoryHandle = await open(directory, constants.O_RDONLY);
        try {
            await directoryHandle.sync();
        } finally {
            await directoryHandle.close();
        }
    } finally {
        await rm(temporary, { force: true });
    }
}

async function pathKind(path: string): Promise<'file' | 'directory' | undefined> {
    try {
        const stats = await lstat(path);
        if (stats.isSymbolicLink()) return undefined;
        if (stats.isFile()) return 'file';
        if (stats.isDirectory()) return 'directory';
        return undefined;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

async function pathIdentity(
    path: string,
): Promise<{ device: string; inode: string; kind: 'file' | 'directory' } | undefined> {
    try {
        const stats = await lstat(path, { bigint: true });
        if (stats.isSymbolicLink()) return undefined;
        const kind = stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : undefined;
        if (!kind) return undefined;
        return { device: stats.dev.toString(), inode: stats.ino.toString(), kind };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

/**
 * Persists the lifecycle boundary around non-cancelable file-system mutations. `pre_stage` may be
 * canceled safely; `staged` durably captures the identities that are revalidated immediately before
 * mutation and is allowed to finish even after its original IPC waiter times out. Final records
 * remain until a Renderer acknowledges the editor and file-tree reconciliation they describe.
 */
export class FileMutationJournal {
    private readonly completionRetryBaseMs: number;
    private readonly executionCancellations = new Map<string, string>();
    private readonly pendingCompletions = new Map<string, PendingCompletion>();
    private readonly records = new Map<string, FileMutationOperation>();
    private readonly runningOperationIds = new Set<string>();
    private readonly runningBySession = new Map<string, number>();
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly maximumActivePerSession: number;
    private readonly now: () => number;
    private readonly preStageTimeoutMs: number;
    private readonly writeJournal: (path: string, source: string) => Promise<void>;
    private initializePromise?: Promise<void>;
    private initialized = false;
    private closed = false;
    private writeTail: Promise<void> = Promise.resolve();

    constructor(
        private readonly path: string | undefined,
        private readonly emit: (event: RuntimeEvent) => void,
        private readonly logger: StructuredLogger,
        options: FileMutationJournalOptions = {},
    ) {
        this.completionRetryBaseMs =
            options.completionRetryBaseMs ?? DEFAULT_COMPLETION_RETRY_BASE_MS;
        this.maximumActivePerSession =
            options.maximumActivePerSession ?? DEFAULT_MAXIMUM_ACTIVE_PER_SESSION;
        this.now = options.now ?? Date.now;
        this.preStageTimeoutMs = options.preStageTimeoutMs ?? DEFAULT_PRE_STAGE_TIMEOUT_MS;
        this.writeJournal = options.writeJournal ?? atomicWrite;
        if (!Number.isFinite(this.completionRetryBaseMs) || this.completionRetryBaseMs < 1)
            throw new RangeError('File operation completion retry delay must be positive');
        if (!Number.isInteger(this.maximumActivePerSession) || this.maximumActivePerSession < 1)
            throw new RangeError('Active file operation capacity must be a positive integer');
        if (!Number.isFinite(this.preStageTimeoutMs) || this.preStageTimeoutMs < 1)
            throw new RangeError('File operation pre-stage timeout must be positive');
    }

    initialize(): Promise<void> {
        this.initializePromise ??= this.loadAndReconcile();
        return this.initializePromise;
    }

    async run<Result extends FileMutationResult>(
        operation: FileMutationOperation,
        execute: (stage: StageMutation) => Promise<Result>,
    ): Promise<Result> {
        this.acquireExecution(operation.sessionId, operation.id);
        try {
            await this.begin(operation);
            const timer = setTimeout(() => {
                void this.cancelPreStage(
                    operation.id,
                    'File operation timed out before any file-system change began',
                );
            }, this.preStageTimeoutMs);
            this.timers.set(operation.id, timer);
            let result: Result;
            try {
                result = await execute((expectedResult) =>
                    this.stage(operation.id, expectedResult),
                );
            } catch (error) {
                const canceledMessage = this.executionCancellations.get(operation.id);
                if (canceledMessage) throw new CaxriError('TIMEOUT', canceledMessage);
                const current = await this.get(operation.id);
                if (current?.phase === 'canceled')
                    throw new CaxriError(
                        'TIMEOUT',
                        current.error?.message ?? 'File operation was canceled before it began',
                    );
                await this.fail(operation.id, error);
                throw error;
            }
            try {
                await this.complete(operation.id, result);
                return result;
            } catch (error) {
                const current = await this.get(operation.id);
                if (current?.phase === 'canceled')
                    throw new CaxriError(
                        'TIMEOUT',
                        current.error?.message ?? 'File operation was canceled before it began',
                    );
                /** A successful staged native mutation must stay recoverable if final persistence fails. */
                if (current?.phase === 'staged') this.scheduleCompletionRetry(operation.id, result);
                else await this.fail(operation.id, error);
                this.logger.write('error', 'file.operation_completion_pending', {
                    durationMs: this.now() - operation.startedAt,
                    fields: {
                        operationId: operation.id,
                        kind: operation.kind,
                        code:
                            (isCaxriError(error) ? error.code : undefined) ??
                            (error as NodeJS.ErrnoException).code ??
                            'IO',
                    },
                });
                throw error;
            }
        } finally {
            this.clearTimer(operation.id);
            this.executionCancellations.delete(operation.id);
            this.releaseExecution(operation.sessionId, operation.id);
        }
    }

    async get(operationId: string): Promise<FileMutationOperation | undefined> {
        await this.initialize();
        await this.writeTail;
        const operation = this.records.get(operationId);
        return operation ? cloneOperation(operation) : undefined;
    }

    async list(): Promise<FileMutationOperation[]> {
        await this.initialize();
        await this.writeTail;
        return [...this.records.values()].map(cloneOperation);
    }

    async cancel(operationId: string): Promise<FileMutationOperation> {
        await this.initialize();
        const operation = await this.mutate(() => {
            const current = this.requireOperation(operationId);
            if (current.phase !== 'pre_stage') return current;
            current.phase = 'canceled';
            current.updatedAt = this.now();
            current.error = {
                code: 'TIMEOUT',
                message: 'File operation was canceled before any file-system change began',
            };
            return current;
        });
        if (operation.phase === 'canceled' && this.runningOperationIds.has(operationId))
            this.executionCancellations.set(
                operationId,
                operation.error?.message ?? 'File operation was canceled before it began',
            );
        this.clearTimer(operationId);
        this.publish(operation);
        return cloneOperation(operation);
    }

    async acknowledge(operationId: string): Promise<void> {
        await this.initialize();
        await this.mutate(() => {
            const operation = this.requireOperation(operationId);
            if (!finalPhases.has(operation.phase))
                throw new CaxriError('CONFLICT', 'File operation is still in progress');
            this.records.delete(operationId);
        });
    }

    async close(): Promise<void> {
        this.closed = true;
        for (const pending of this.pendingCompletions.values())
            if (pending.timer) clearTimeout(pending.timer);
        this.pendingCompletions.clear();
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        const canceled = await this.mutate(() => {
            const operations: FileMutationOperation[] = [];
            for (const operation of this.records.values()) {
                if (operation.phase !== 'pre_stage') continue;
                operation.phase = 'canceled';
                operation.updatedAt = this.now();
                operation.error = {
                    code: 'UNAVAILABLE',
                    message: 'Runtime stopped before the file operation began',
                };
                operations.push(operation);
            }
            return operations;
        });
        for (const operation of canceled) {
            if (this.runningOperationIds.has(operation.id))
                this.executionCancellations.set(
                    operation.id,
                    operation.error?.message ?? 'Runtime stopped before the file operation began',
                );
            this.publish(operation);
        }
        await this.writeTail;
    }

    private async loadAndReconcile(): Promise<void> {
        if (this.initialized) return;
        if (this.path) {
            try {
                const parsed = z
                    .array(fileMutationOperationSchema)
                    .max(MAXIMUM_RETAINED_OPERATIONS)
                    .parse(JSON.parse(await readFile(this.path, 'utf8')));
                for (const operation of parsed) this.records.set(operation.id, operation);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        }
        this.initialized = true;
        let changed = false;
        for (const operation of this.records.values()) {
            let recovered = false;
            if (operation.phase === 'pre_stage') {
                operation.phase = 'canceled';
                operation.updatedAt = this.now();
                operation.error = {
                    code: 'UNAVAILABLE',
                    message: 'Runtime restarted before the file operation began',
                };
                changed = true;
                recovered = true;
            } else if (operation.phase === 'staged') {
                await this.reconcileStaged(operation);
                changed = true;
                recovered = true;
            }
            if (recovered && finalPhases.has(operation.phase))
                this.logger.write('info', 'file.operation_recovered', {
                    durationMs: operation.updatedAt - operation.startedAt,
                    fields: {
                        operationId: operation.id,
                        kind: operation.kind,
                        phase: operation.phase,
                    },
                });
        }
        if (changed) await this.persist();
    }

    private async reconcileStaged(operation: FileMutationOperation): Promise<void> {
        let completed = false;
        if (operation.kind === 'create') {
            const expected = operation.expectedResult;
            if (expected?.device && expected.inode) {
                const target = await pathIdentity(expected.path);
                completed =
                    target?.kind === expected.kind &&
                    target.device === expected.device &&
                    target.inode === expected.inode;
            }
        } else {
            const expected = operation.expectedResult;
            if (!expected) return this.failStagedRecovery(operation);
            const [target, sourceKind] = await Promise.all([
                pathIdentity(expected.path),
                pathKind(expected.previousPath),
            ]);
            completed =
                target?.kind === expected.kind &&
                target.device === expected.device &&
                target.inode === expected.inode &&
                sourceKind === undefined;
        }
        operation.updatedAt = this.now();
        if (completed && operation.expectedResult) {
            operation.phase = 'completed';
            operation.result = operation.expectedResult;
            delete operation.error;
            return;
        }
        this.failStagedRecovery(operation);
    }

    private failStagedRecovery(operation: FileMutationOperation): void {
        operation.updatedAt = this.now();
        operation.phase = 'failed';
        operation.error = {
            code: 'UNAVAILABLE',
            message:
                'Runtime restarted before the staged file operation could be confirmed; files were preserved and the file tree will be refreshed',
        };
    }

    private async begin(operation: FileMutationOperation): Promise<void> {
        await this.initialize();
        if (this.closed) throw new CaxriError('UNAVAILABLE', 'File operation journal is closed');
        const current = await this.mutate(() => {
            if (this.records.has(operation.id))
                throw new CaxriError('CONFLICT', 'File operation ID is already in use');
            if (this.records.size >= MAXIMUM_RETAINED_OPERATIONS)
                throw new CaxriError(
                    'CAPACITY',
                    'Too many file operation results are waiting to be reconciled',
                );
            const parsed = fileMutationOperationSchema.parse(operation);
            this.records.set(parsed.id, parsed);
            return parsed;
        });
        this.publish(current);
    }

    private async stage(
        operationId: string,
        expectedResult: FileMutationExpectedResult,
    ): Promise<void> {
        const operation = await this.mutate(() => {
            const cancellation = this.executionCancellations.get(operationId);
            if (cancellation) throw new CaxriError('TIMEOUT', cancellation);
            const current = this.requireOperation(operationId);
            if (current.phase === 'canceled')
                throw new CaxriError(
                    'TIMEOUT',
                    current.error?.message ?? 'File operation was canceled before it began',
                );
            if (current.phase === 'staged') {
                if (
                    current.kind !== 'create' ||
                    !('device' in expectedResult) ||
                    !expectedResult.device ||
                    !expectedResult.inode ||
                    !current.expectedResult ||
                    current.expectedResult.path !== expectedResult.path ||
                    current.expectedResult.kind !== expectedResult.kind ||
                    current.expectedResult.name !== expectedResult.name
                )
                    throw new CaxriError(
                        'CONFLICT',
                        'File operation cannot replace its staged result',
                    );
                current.expectedResult = expectedResult;
                current.updatedAt = this.now();
                return current;
            }
            if (current.phase !== 'pre_stage')
                throw new CaxriError('CONFLICT', 'File operation cannot enter staging twice');
            current.phase = 'staged';
            current.expectedResult = expectedResult;
            current.updatedAt = this.now();
            return current;
        });
        this.clearTimer(operationId);
        this.publish(operation);
    }

    private async complete(operationId: string, result: FileMutationResult): Promise<void> {
        const operation = await this.mutate(() => {
            const current = this.requireOperation(operationId);
            if (current.phase === 'canceled')
                throw new CaxriError('TIMEOUT', 'Canceled file operation cannot complete');
            if (current.phase !== 'pre_stage' && current.phase !== 'staged')
                throw new CaxriError('CONFLICT', 'File operation is already complete');
            current.phase = 'completed';
            current.result = result;
            current.updatedAt = this.now();
            delete current.error;
            return current;
        });
        this.publish(operation);
    }

    private async fail(operationId: string, error: unknown): Promise<void> {
        const operation = await this.mutate(() => {
            const current = this.records.get(operationId);
            if (!current || finalPhases.has(current.phase)) return current;
            current.phase = 'failed';
            current.updatedAt = this.now();
            current.error = operationFailure(error);
            return current;
        });
        if (operation) this.publish(operation);
    }

    private async cancelPreStage(operationId: string, message: string): Promise<void> {
        const operation = await this.mutate(() => {
            const current = this.records.get(operationId);
            if (!current || current.phase !== 'pre_stage') return undefined;
            current.phase = 'canceled';
            current.updatedAt = this.now();
            current.error = { code: 'TIMEOUT', message };
            return current;
        });
        if (operation) {
            if (this.runningOperationIds.has(operationId))
                this.executionCancellations.set(operationId, message);
            this.clearTimer(operationId);
            this.publish(operation);
        }
    }

    private mutate<Value>(mutation: () => Value | Promise<Value>): Promise<Value> {
        const result = this.writeTail.then(async () => {
            const previous = [...this.records.entries()].map(
                ([id, operation]) => [id, cloneOperation(operation)] as const,
            );
            try {
                const value = await mutation();
                await this.persist();
                return value;
            } catch (error) {
                this.records.clear();
                for (const [id, operation] of previous) this.records.set(id, operation);
                throw error;
            }
        });
        this.writeTail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    private async persist(): Promise<void> {
        const records = z
            .array(fileMutationOperationSchema)
            .max(MAXIMUM_RETAINED_OPERATIONS)
            .parse([...this.records.values()]);
        if (!this.path) return;
        const source = `${JSON.stringify(records, null, 2)}\n`;
        await this.writeJournal(this.path, source);
    }

    private requireOperation(operationId: string): FileMutationOperation {
        const operation = this.records.get(operationId);
        if (!operation) throw new CaxriError('NOT_FOUND', 'File operation was not found');
        return operation;
    }

    private acquireExecution(sessionId: string, operationId: string): void {
        const running = this.runningBySession.get(sessionId) ?? 0;
        if (running >= this.maximumActivePerSession)
            throw new CaxriError(
                'CAPACITY',
                'Too many file changes are already active in this Session',
            );
        this.runningBySession.set(sessionId, running + 1);
        this.runningOperationIds.add(operationId);
    }

    private releaseExecution(sessionId: string, operationId: string): void {
        this.runningOperationIds.delete(operationId);
        const running = this.runningBySession.get(sessionId) ?? 0;
        if (running <= 1) this.runningBySession.delete(sessionId);
        else this.runningBySession.set(sessionId, running - 1);
    }

    private scheduleCompletionRetry(operationId: string, result: FileMutationResult): void {
        if (this.closed || this.pendingCompletions.has(operationId)) return;
        const pending: PendingCompletion = { attempt: 0, result };
        this.pendingCompletions.set(operationId, pending);
        const schedule = (): void => {
            if (this.closed || !this.pendingCompletions.has(operationId)) return;
            const delay = Math.min(
                this.completionRetryBaseMs * 2 ** pending.attempt,
                MAXIMUM_COMPLETION_RETRY_MS,
            );
            pending.timer = setTimeout(() => {
                void retry();
            }, delay);
        };
        const retry = async (): Promise<void> => {
            if (this.closed) return;
            try {
                await this.complete(operationId, pending.result);
                this.pendingCompletions.delete(operationId);
            } catch (error) {
                const operation = await this.get(operationId).catch(() => undefined);
                if (!operation || finalPhases.has(operation.phase)) {
                    this.pendingCompletions.delete(operationId);
                    return;
                }
                pending.attempt += 1;
                this.logger.write('warn', 'file.operation_completion_retry', {
                    fields: {
                        operationId,
                        attempt: pending.attempt,
                        code:
                            (isCaxriError(error) ? error.code : undefined) ??
                            (error as NodeJS.ErrnoException).code ??
                            'IO',
                    },
                });
                schedule();
            }
        };
        schedule();
    }

    private publish(operation: FileMutationOperation): void {
        const snapshot = cloneOperation(operation);
        this.emit({ event: 'files.operationChanged', payload: snapshot });
        this.logger.write(
            snapshot.phase === 'failed' || snapshot.phase === 'canceled' ? 'warn' : 'info',
            'file.operation_phase',
            {
                durationMs: snapshot.updatedAt - snapshot.startedAt,
                fields: {
                    operationId: snapshot.id,
                    kind: snapshot.kind,
                    phase: snapshot.phase,
                    sessionId: snapshot.sessionId,
                },
            },
        );
    }

    private clearTimer(operationId: string): void {
        const timer = this.timers.get(operationId);
        if (timer) clearTimeout(timer);
        this.timers.delete(operationId);
    }
}
