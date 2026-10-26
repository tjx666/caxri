import type {
    FileMutationOperation,
    MovedFileEntry,
    MutableFileEntry,
    ServerEvent,
} from '@caxri/protocol';
import {
    CaxriError,
    errorMessage,
    fileMutationOperationSchema,
    isCaxriError,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { z } from 'zod';

import { atomicWrite } from '../atomic-file';
import {
    cloneOperation,
    operationFailure,
    pathIdentity,
    pathKind,
    readJournalRecords,
} from './mutation-journal-support';

type FileMutationResult = MutableFileEntry | MovedFileEntry;
type FileMutationExpectedResult = NonNullable<FileMutationOperation['expectedResult']>;
type StageMutation = (expectedResult: FileMutationExpectedResult) => Promise<void>;

export interface FileMutationOperationScope {
    sessionId: string;
    workbenchProjectId: string;
}

export interface FileMutationJournalOptions {
    /**
     * Test seam for shortening in-process finalization retries.
     */
    completionRetryBaseMs?: number;
    maximumActivePerSession?: number;
    now?: () => number;
    preStageTimeoutMs?: number;
    /**
     * Test seam for transient journal persistence failures.
     */
    writeJournal?: (path: string, source: string) => Promise<void>;
}

interface PendingCompletion {
    attempt: number;
    expectedResult?: FileMutationExpectedResult;
    result: FileMutationResult;
    timer?: ReturnType<typeof setTimeout>;
}

class StagedCreatePersistenceError extends Error {
    constructor(
        readonly expectedResult: FileMutationExpectedResult,
        options: ErrorOptions,
    ) {
        super('Created item identity is waiting for journal persistence', options);
        this.name = 'StagedCreatePersistenceError';
    }
}

/**
 * Lets the file-system service preserve the journal's post-native retry signal unchanged.
 */
export function isStagedCreatePersistenceError(error: unknown): error is Error {
    return error instanceof StagedCreatePersistenceError;
}

const MAXIMUM_RETAINED_OPERATIONS = 256;
const DEFAULT_MAXIMUM_ACTIVE_PER_SESSION = 8;
const DEFAULT_PRE_STAGE_TIMEOUT_MS = 15_000;
const DEFAULT_COMPLETION_RETRY_BASE_MS = 250;
const MAXIMUM_COMPLETION_RETRY_MS = 30_000;
const finalPhases = new Set<FileMutationOperation['phase']>(['completed', 'failed', 'canceled']);

/**
 * Persists the lifecycle boundary around non-cancelable file-system mutations. `pre_stage` may be canceled safely;
 * `staged` durably captures the identities that are revalidated immediately before mutation and is allowed to finish
 * even after its original IPC waiter times out. Final records remain until a Renderer acknowledges the editor and
 * file-tree reconciliation they describe.
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
        private readonly emit: (event: ServerEvent) => void,
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
        if (!Number.isSafeInteger(this.maximumActivePerSession) || this.maximumActivePerSession < 1)
            throw new RangeError('Active file operation capacity must be a positive integer');
        if (!Number.isFinite(this.preStageTimeoutMs) || this.preStageTimeoutMs < 1)
            throw new RangeError('File operation pre-stage timeout must be positive');
    }

    private async loadAndReconcile(): Promise<void> {
        if (this.initialized) return;
        if (this.path) {
            const parsed = await readJournalRecords(this.path, MAXIMUM_RETAINED_OPERATIONS);
            for (const operation of parsed) this.records.set(operation.id, operation);
        }
        this.initialized = true;
        /**
         * Recovery stays sequential because staged paths may overlap and native identity checks mutate records.
         */
        let isChanged = false;
        for (const operation of this.records.values()) {
            // eslint-disable-next-line no-await-in-loop -- recovery must run sequentially; see comment above
            if (await this.recoverOperation(operation)) isChanged = true;
        }
        if (isChanged) await this.persist();
    }

    private async recoverOperation(operation: FileMutationOperation): Promise<boolean> {
        let isRecovered = false;
        if (operation.phase === 'pre_stage') {
            operation.phase = 'canceled';
            operation.updatedAt = this.now();
            operation.error = {
                code: 'UNAVAILABLE',
                message: 'Runtime restarted before the file operation began',
            };
            isRecovered = true;
        } else if (operation.phase === 'staged') {
            await this.reconcileStaged(operation);
            isRecovered = true;
        }
        if (isRecovered && finalPhases.has(operation.phase))
            this.logger.write('info', logEventCatalog.file.operationRecovered, {
                durationMs: operation.updatedAt - operation.startedAt,
                fields: {
                    operationId: operation.id,
                    kind: operation.kind,
                    phase: operation.phase,
                },
            });
        return isRecovered;
    }

    private async reconcileStaged(operation: FileMutationOperation): Promise<void> {
        const isCompleted = await this.expectedResultMatches(operation, operation.expectedResult);
        operation.updatedAt = this.now();
        if (isCompleted && operation.expectedResult) {
            operation.phase = 'completed';
            operation.result = operation.expectedResult;
            delete operation.error;
            return;
        }
        this.failStagedRecovery(operation);
    }

    private async expectedResultMatches(
        operation: FileMutationOperation,
        expected: FileMutationExpectedResult | undefined,
    ): Promise<boolean> {
        if (!expected?.device || !expected.inode) return false;
        const target = await pathIdentity(expected.path);
        if (target?.kind !== expected.kind || target.inode !== expected.inode) return false;
        /**
         * MacOS can renumber devices after a restart, while another volume mounted at the same path may reuse an inode.
         * A changed device therefore requires the original creation time as an additional match. Older staged records
         * without that timestamp fail closed and keep their files untouched.
         */
        if (
            target.device !== expected.device &&
            (!expected.birthtime ||
                expected.birthtime === '0' ||
                target.birthtime !== expected.birthtime)
        )
            return false;
        if (operation.kind === 'create') return true;
        if (!('previousPath' in expected)) return false;
        return (await pathKind(expected.previousPath)) === undefined;
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
        let isRefinesCreatedIdentity = false;
        let operation: FileMutationOperation;
        try {
            operation = await this.mutate(() => {
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
                    isRefinesCreatedIdentity = true;
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
        } catch (error) {
            /**
             * The native create already succeeded before its inode refinement is persisted. Keep the durable pre-create
             * stage and retry the identity plus completion in-process.
             */
            // The type-aware checker does not account for `isRefinesCreatedIdentity` being reassigned
            // inside the `this.mutate(() => {...})` callback above (`tsc --strict` correctly widens
            // this to `boolean`); dropping the check would misclassify a create-refinement failure.
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- reassigned inside the mutate() callback; checker narrowing is a false positive
            if (isRefinesCreatedIdentity)
                throw new StagedCreatePersistenceError(expectedResult, { cause: error });
            throw error;
        }
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
            if (current?.phase !== 'pre_stage') return;
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

    /**
     * Must stay synchronous (not `async`): `this.writeTail` is chained and reassigned in the same tick that `mutate` is
     * called, so back-to-back synchronous invocations serialize onto the same tail instead of racing to read a
     * not-yet-updated `writeTail`. Converting the body to `async`/`await` would insert a microtask boundary before
     * `this.writeTail` is reassigned below.
     */
    private mutate<Value>(mutation: () => Value | Promise<Value>): Promise<Value> {
        // eslint-disable-next-line unicorn/prefer-await -- see class member docstring above
        const result = this.writeTail.then(async () => {
            const previous = [...this.records].map(
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
        // eslint-disable-next-line unicorn/prefer-await, unicorn/prefer-then-catch -- see class member docstring above
        this.writeTail = result.then(
            () => {},
            () => {},
        );
        return result;
    }

    private async persist(): Promise<void> {
        if (!this.path) return;
        const records = z
            .array(fileMutationOperationSchema)
            .max(MAXIMUM_RETAINED_OPERATIONS)
            .parse(this.records.values().toArray());
        const source = `${JSON.stringify(records, null, 2)}\n`;
        await this.writeJournal(this.path, source);
    }

    private requireOperation(operationId: string): FileMutationOperation {
        const operation = this.records.get(operationId);
        if (!operation) throw new CaxriError('NOT_FOUND', 'File operation was not found');
        return operation;
    }

    private belongsToScope(
        operation: FileMutationOperation,
        scope: FileMutationOperationScope,
    ): boolean {
        return operation.workbenchProjectId === scope.workbenchProjectId;
    }

    private requireOperationInScope(
        operationId: string,
        scope?: FileMutationOperationScope,
    ): FileMutationOperation {
        const operation = this.requireOperation(operationId);
        if (scope && !this.belongsToScope(operation, scope))
            throw new CaxriError('PATH_DENIED', 'File operation is outside the selected Project');
        return operation;
    }

    private async cancelInScope(
        operationId: string,
        scope?: FileMutationOperationScope,
    ): Promise<FileMutationOperation> {
        await this.initialize();
        const operation = await this.mutate(() => {
            const current = this.requireOperationInScope(operationId, scope);
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

    private async acknowledgeInScope(
        operationId: string,
        scope?: FileMutationOperationScope,
    ): Promise<void> {
        await this.initialize();
        await this.mutate(() => {
            const operation = this.requireOperationInScope(operationId, scope);
            if (!finalPhases.has(operation.phase))
                throw new CaxriError('CONFLICT', 'File operation is still in progress');
            this.records.delete(operationId);
        });
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

    private scheduleCompletionRetry(
        operationId: string,
        result: FileMutationResult,
        expectedResult?: FileMutationExpectedResult,
    ): void {
        if (this.closed || this.pendingCompletions.has(operationId)) return;
        const pending: PendingCompletion = { attempt: 0, expectedResult, result };
        this.pendingCompletions.set(operationId, pending);
        /**
         * `schedule` and `retry` are mutually recursive (the timer calls `retry`, whose catch branch calls `schedule`
         * again), so one of the two must be referenced before its own declaration. A boxed reference avoids a
         * `let`-then-reassign pattern that would otherwise trip `prefer-const` since `retryReference.current` is only
         * ever assigned once.
         */
        const retryReference: { current?: () => Promise<void> } = {};
        const schedule = (): void => {
            if (this.closed || !this.pendingCompletions.has(operationId)) return;
            const delay = Math.min(
                this.completionRetryBaseMs * 2 ** pending.attempt,
                MAXIMUM_COMPLETION_RETRY_MS,
            );
            pending.timer = setTimeout(() => {
                // `setTimeout`'s callback is a synchronous event handler and cannot be `await`ed,
                // so the rejection is deliberately observed through `.catch()` instead.
                // eslint-disable-next-line unicorn/prefer-await -- see comment above
                retryReference.current?.().catch((error: unknown) => {
                    this.logger.write(
                        'error',
                        logEventCatalog.file.operationCompletionRetryFailed,
                        {
                            fields: { operationId, error: errorMessage(error, 'unknown') },
                        },
                    );
                });
            }, delay);
        };
        const retry = async (): Promise<void> => {
            if (this.closed) return;
            try {
                const operation = await this.get(operationId);
                const expected = pending.expectedResult ?? operation?.expectedResult;
                if (
                    operation?.phase !== 'staged' ||
                    !(await this.expectedResultMatches(operation, expected))
                ) {
                    if (operation && !finalPhases.has(operation.phase))
                        await this.fail(
                            operationId,
                            new CaxriError(
                                'CONFLICT',
                                'File operation target changed before completion could be recorded',
                            ),
                        );
                    this.pendingCompletions.delete(operationId);
                    return;
                }
                if (pending.expectedResult) {
                    await this.stage(operationId, pending.expectedResult);
                    pending.expectedResult = undefined;
                }
                const staged = await this.get(operationId);
                if (!staged || !(await this.expectedResultMatches(staged, staged.expectedResult))) {
                    await this.fail(
                        operationId,
                        new CaxriError(
                            'CONFLICT',
                            'File operation target changed before completion could be recorded',
                        ),
                    );
                    this.pendingCompletions.delete(operationId);
                    return;
                }
                await this.complete(operationId, pending.result);
                this.pendingCompletions.delete(operationId);
            } catch (error) {
                let operation: FileMutationOperation | undefined;
                try {
                    operation = await this.get(operationId);
                } catch {
                    operation = undefined;
                }
                if (!operation || finalPhases.has(operation.phase)) {
                    this.pendingCompletions.delete(operationId);
                    return;
                }
                pending.attempt += 1;
                this.logger.write('warn', logEventCatalog.file.operationCompletionRetry, {
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
        retryReference.current = retry;
        schedule();
    }

    private publish(operation: FileMutationOperation): void {
        const snapshot = cloneOperation(operation);
        this.emit({
            event: 'files.operationChanged',
            payload: {
                operationId: snapshot.id,
                sessionId: snapshot.sessionId,
                workbenchProjectId: snapshot.workbenchProjectId,
            },
        });
        this.logger.write(
            snapshot.phase === 'failed' || snapshot.phase === 'canceled' ? 'warn' : 'info',
            logEventCatalog.file.operationPhase,
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
                // `setTimeout`'s callback is a synchronous event handler and cannot be `await`ed,
                // so the rejection is deliberately observed through `.catch()` instead.
                this.cancelPreStage(
                    operation.id,
                    'File operation timed out before any file-system change began',
                )
                    // eslint-disable-next-line unicorn/prefer-await -- see comment above
                    .catch((error: unknown) => {
                        this.logger.write('error', logEventCatalog.file.operationCancelFailed, {
                            fields: {
                                operationId: operation.id,
                                error: errorMessage(error, 'unknown'),
                            },
                        });
                    });
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
                if (error instanceof StagedCreatePersistenceError) {
                    const result: FileMutationResult = {
                        kind: error.expectedResult.kind,
                        name: error.expectedResult.name,
                        path: error.expectedResult.path,
                    };
                    this.scheduleCompletionRetry(operation.id, result, error.expectedResult);
                    this.logger.write('error', logEventCatalog.file.operationCompletionPending, {
                        durationMs: this.now() - operation.startedAt,
                        fields: {
                            operationId: operation.id,
                            kind: operation.kind,
                            code: (error.cause as NodeJS.ErrnoException | undefined)?.code ?? 'IO',
                        },
                    });
                    throw error.cause instanceof Error ? error.cause : error;
                }
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
                /**
                 * A successful staged native mutation must stay recoverable if final persistence fails.
                 */
                if (current?.phase === 'staged') this.scheduleCompletionRetry(operation.id, result);
                else await this.fail(operation.id, error);
                this.logger.write('error', logEventCatalog.file.operationCompletionPending, {
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

    async getScoped(
        operationId: string,
        scope: FileMutationOperationScope,
    ): Promise<FileMutationOperation | undefined> {
        const operation = await this.get(operationId);
        return operation && this.belongsToScope(operation, scope) ? operation : undefined;
    }

    async list(): Promise<FileMutationOperation[]> {
        await this.initialize();
        await this.writeTail;
        return this.records.values().map(cloneOperation).toArray();
    }

    async listScoped(scope: FileMutationOperationScope): Promise<FileMutationOperation[]> {
        return (await this.list()).filter((operation) => this.belongsToScope(operation, scope));
    }

    cancel(operationId: string): Promise<FileMutationOperation> {
        return this.cancelInScope(operationId);
    }

    cancelScoped(
        operationId: string,
        scope: FileMutationOperationScope,
    ): Promise<FileMutationOperation> {
        return this.cancelInScope(operationId, scope);
    }

    acknowledge(operationId: string): Promise<void> {
        return this.acknowledgeInScope(operationId);
    }

    acknowledgeScoped(operationId: string, scope: FileMutationOperationScope): Promise<void> {
        return this.acknowledgeInScope(operationId, scope);
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
}
