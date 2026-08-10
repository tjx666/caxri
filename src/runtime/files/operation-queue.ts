import { CaxriError } from '../../shared/ipc/errors';
import { AsyncSemaphore } from '../../shared/node/concurrency';

const DEFAULT_MAXIMUM_PENDING_OPERATIONS = 64;

export interface FileOperationRunOptions {
    /** Cancels work that has not started before this queue-only deadline. */
    maximumWaitMs?: number;
}

/**
 * Serializes document I/O and file mutations so a path cannot move while Runtime is still using
 * its old identity. The bounded wait list also prevents repeated copy requests from consuming
 * unbounded memory while a large recursive operation is active.
 */
export class FileOperationQueue {
    private readonly operations = new AsyncSemaphore(1);
    private pending = 0;

    constructor(private readonly maximumPendingOperations = DEFAULT_MAXIMUM_PENDING_OPERATIONS) {
        if (!Number.isInteger(maximumPendingOperations) || maximumPendingOperations < 1)
            throw new RangeError('File operation capacity must be a positive integer');
    }

    async run<Value>(
        operation: () => Promise<Value>,
        options: FileOperationRunOptions = {},
    ): Promise<Value> {
        if (
            options.maximumWaitMs !== undefined &&
            (!Number.isFinite(options.maximumWaitMs) || options.maximumWaitMs < 0)
        )
            throw new RangeError('File operation wait time must be a non-negative number');
        if (this.pending >= this.maximumPendingOperations)
            throw new CaxriError(
                'CAPACITY',
                'Too many file operations are waiting; try again after the current operation finishes',
            );
        this.pending += 1;
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const queued = this.operations
            .run(async () => {
                if (timer) clearTimeout(timer);
                if (timedOut)
                    throw new CaxriError(
                        'TIMEOUT',
                        'File operation timed out before it could start',
                    );
                return operation();
            })
            .finally(() => {
                this.pending -= 1;
            });
        if (options.maximumWaitMs === undefined) return queued;
        const waitTimeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                timedOut = true;
                reject(new CaxriError('TIMEOUT', 'File operation timed out before it could start'));
            }, options.maximumWaitMs);
        });
        return Promise.race([queued, waitTimeout]);
    }
}
