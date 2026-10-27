import { describe, expect, it, vi } from 'vitest';

import { SharedProcessList } from '../process-list';

function controlledReads() {
    const reads: Array<PromiseWithResolvers<string>> = [];
    const read = vi.fn(() => {
        const next = Promise.withResolvers<string>();
        reads.push(next);
        return next.promise;
    });
    return { read, reads };
}

describe('SharedProcessList', () => {
    it('lets concurrent callers join the read in flight', async () => {
        const { read, reads } = controlledReads();
        const list = new SharedProcessList({ now: () => 0, read });
        const results = [list.read(), list.read(), list.read()];
        reads[0].resolve('table');

        await expect(Promise.all(results)).resolves.toEqual(['table', 'table', 'table']);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('reuses a finished read inside the window and reads again after it', async () => {
        let clock = 0;
        const { read, reads } = controlledReads();
        const list = new SharedProcessList({ now: () => clock, read, reuseMs: 400 });
        const first = list.read();
        reads[0].resolve('first');
        await first;

        clock = 399;
        await expect(list.read()).resolves.toBe('first');
        expect(read).toHaveBeenCalledTimes(1);

        clock = 400;
        const second = list.read();
        reads[1].resolve('second');
        await expect(second).resolves.toBe('second');
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('never reuses a failed read', async () => {
        const { read, reads } = controlledReads();
        const list = new SharedProcessList({ now: () => 0, read });
        const failed = list.read();
        reads[0].reject(new Error('ps timed out'));
        await expect(failed).rejects.toThrow('ps timed out');

        const retried = list.read();
        reads[1].resolve('table');
        await expect(retried).resolves.toBe('table');
        expect(read).toHaveBeenCalledTimes(2);
    });
});
