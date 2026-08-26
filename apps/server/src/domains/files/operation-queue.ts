import { resolve } from 'node:path';

import { CaxriError } from '@caxri/protocol';

import { isSameOrInside } from '../path-security';

const DEFAULT_MAXIMUM_PENDING_OPERATIONS = 64;

export interface FileOperationRunOptions {
    /**
     * Operations in the same group remain serial even when their filesystem paths differ.
     */
    group?: string;
    /**
     * Cancels work that has not started before this queue-only deadline.
     */
    maximumWaitMs?: number;
    /**
     * Filesystem paths whose identity must remain stable for the complete operation.
     */
    paths?: readonly string[];
}

interface ScheduledOperation {
    exclusive: boolean;
    group?: string;
    operation: () => Promise<unknown>;
    paths: string[];
    reject: (error: unknown) => void;
    resolve: (value: unknown) => void;
    timer?: ReturnType<typeof setTimeout>;
}

function arePathsOverlapping(first: readonly string[], second: readonly string[]): boolean {
    return first.some((left) =>
        second.some((right) => isSameOrInside(left, right) || isSameOrInside(right, left)),
    );
}

function hasConflict(first: ScheduledOperation, second: ScheduledOperation): boolean {
    if (first.exclusive || second.exclusive) return true;
    if (first.group && first.group === second.group) return true;
    return arePathsOverlapping(first.paths, second.paths);
}

/**
 * Coordinates document I/O and file mutations by path. Overlapping operations stay ordered while unrelated files can
 * proceed during a long recursive copy; a named group bounds work within its coordination scope. Calls without paths or
 * a group retain the previous exclusive FIFO behavior.
 */
export class FileOperationQueue {
    private readonly active = new Set<ScheduledOperation>();
    private readonly waiting: ScheduledOperation[] = [];

    constructor(private readonly maximumPendingOperations = DEFAULT_MAXIMUM_PENDING_OPERATIONS) {
        if (!Number.isSafeInteger(maximumPendingOperations) || maximumPendingOperations < 1)
            throw new RangeError('File operation capacity must be a positive integer');
    }

    private drain(): void {
        for (let index = 0; index < this.waiting.length;) {
            const scheduled = this.waiting[index];
            const isConflictsWithActive = [...this.active].some((active) =>
                hasConflict(active, scheduled),
            );
            const isBypassesEarlierConflict = this.waiting
                .slice(0, index)
                .some((earlier) => hasConflict(earlier, scheduled));
            if (isConflictsWithActive || isBypassesEarlierConflict) {
                index += 1;
                continue;
            }
            this.waiting.splice(index, 1);
            if (scheduled.timer) clearTimeout(scheduled.timer);
            this.active.add(scheduled);
            const run = async (): Promise<void> => {
                try {
                    scheduled.resolve(await scheduled.operation());
                } catch (error) {
                    scheduled.reject(error);
                } finally {
                    this.active.delete(scheduled);
                    this.drain();
                }
            };
            /**
             * `drain()` synchronously loops over `this.waiting` to start every operation whose dependencies are already
             * satisfied; each started operation must run independently in the background rather than blocking the loop,
             * so its completion is deliberately observed fire-and-forget. `run` never rejects (its `try`/`catch`
             * handles every failure internally), so this `.catch()` only satisfies the floating-promise check.
             */
            // eslint-disable-next-line unicorn/prefer-await -- see comment above
            run().catch(() => {});
        }
    }

    run<Value>(
        operation: () => Promise<Value>,
        options: FileOperationRunOptions = {},
    ): Promise<Value> {
        if (
            options.maximumWaitMs !== undefined &&
            (!Number.isFinite(options.maximumWaitMs) || options.maximumWaitMs < 0)
        )
            return Promise.reject(
                new RangeError('File operation wait time must be a non-negative number'),
            );
        if (this.active.size + this.waiting.length >= this.maximumPendingOperations)
            return Promise.reject(
                new CaxriError(
                    'CAPACITY',
                    'Too many file operations are waiting; try again after the current operation finishes',
                ),
            );

        return new Promise<Value>((_resolve, _reject) => {
            const paths = [...new Set((options.paths ?? []).map((path) => resolve(path)))];
            const scheduled: ScheduledOperation = {
                exclusive: paths.length === 0 && !options.group,
                group: options.group,
                operation,
                paths,
                reject: _reject,
                resolve: (value) => _resolve(value as Value),
            };
            this.waiting.push(scheduled);
            this.drain();
            if (options.maximumWaitMs !== undefined && this.waiting.includes(scheduled)) {
                scheduled.timer = setTimeout(() => {
                    const index = this.waiting.indexOf(scheduled);
                    if (index === -1) return;
                    this.waiting.splice(index, 1);
                    scheduled.reject(
                        new CaxriError('TIMEOUT', 'File operation timed out before it could start'),
                    );
                    this.drain();
                }, options.maximumWaitMs);
            }
        });
    }
}
