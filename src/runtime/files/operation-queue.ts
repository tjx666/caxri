import { CaxriError } from '../../shared/ipc/errors';
import { AsyncSemaphore } from '../../shared/node/concurrency';

const DEFAULT_MAXIMUM_PENDING_OPERATIONS = 64;

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

    async run<Value>(operation: () => Promise<Value>): Promise<Value> {
        if (this.pending >= this.maximumPendingOperations)
            throw new CaxriError(
                'CAPACITY',
                'Too many file operations are waiting; try again after the current operation finishes',
            );
        this.pending += 1;
        try {
            return await this.operations.run(operation);
        } finally {
            this.pending -= 1;
        }
    }
}
