import { BINARY_STREAM_MAX_BUFFERED_BYTES } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { TerminalOperationQueue } from '../terminal-operation-queue';

describe('TerminalOperationQueue', () => {
    it('rejects retained input beyond the shared byte budget', async () => {
        const queue = new TerminalOperationQueue();

        await expect(
            queue.run(
                'terminal-1',
                () => Promise.resolve(null),
                BINARY_STREAM_MAX_BUFFERED_BYTES + 1,
            ),
        ).rejects.toMatchObject({ code: 'CAPACITY' });
    });

    it('cancels queued work without waiting for its predecessor', async () => {
        const queue = new TerminalOperationQueue();
        const predecessor = Promise.withResolvers<void>();
        const started = vi.fn();
        const first = queue.run('terminal-1', async () => {
            started();
            await predecessor.promise;
        });
        await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
        const queued = queue.run('terminal-1', () => Promise.resolve());

        queue.invalidate('terminal-1');
        await expect(queued).rejects.toMatchObject({ code: 'CANCELLED' });

        predecessor.resolve();
        await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    });

    it('holds later work until a lifecycle barrier is released', async () => {
        const queue = new TerminalOperationQueue();
        const release = queue.block('terminal-1');
        const started = vi.fn();
        const pending = queue.run('terminal-1', () => {
            started();
            return Promise.resolve('completed');
        });

        await Promise.resolve();
        expect(started).not.toHaveBeenCalled();

        release();
        release();
        await expect(pending).resolves.toBe('completed');
        expect(started).toHaveBeenCalledOnce();
    });
});
